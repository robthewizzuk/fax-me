import {
  getCodecSpec,
  buildRtpPacket,
  parseRtpPacket,
  encodeMulaw,
  decodeMulaw,
  encodeAlaw,
  decodeAlaw,
  G722State,
  G729State,
  resamplePcm16,
  applyLineStaticPcm16,
  pcm16ToWavBytes,
  buildPcapBytes,
} from '../../../shared/sipCodecs.js';

const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

function synthesizeClientSpeechPcm16(text = 'HELLO LIVE TEST', sampleRate = 8000) {
  const clean = String(text || 'HELLO').toUpperCase().slice(0, 48);
  const segLen = Math.round(sampleRate * 0.085);
  const gapLen = Math.round(sampleRate * 0.015);
  const out = new Int16Array(Math.max(sampleRate * 0.6, clean.length * (segLen + gapLen)));
  let offset = 0;
  for (let idx = 0; idx < clean.length; idx++) {
    const ch = clean.charCodeAt(idx);
    if (ch === 32) {
      offset += Math.round(segLen * 0.6);
      continue;
    }
    const f0 = 135 + ((ch * 17) % 90);
    const f1 = 420 + ((ch * 53) % 450);
    const f2 = 1200 + ((ch * 97) % 1100);
    for (let i = 0; i < segLen && offset + i < out.length; i++) {
      const env = Math.sin((Math.PI * i) / segLen);
      const buzz =
        0.48 * Math.sin((2 * Math.PI * f0 * i) / sampleRate) +
        0.34 * Math.sin((2 * Math.PI * f1 * i) / sampleRate) +
        0.18 * Math.sin((2 * Math.PI * f2 * i) / sampleRate);
      out[offset + i] = Math.round(buzz * env * 11500);
    }
    offset += segLen + gapLen;
  }
  return out;
}

export class LiveSipCallEngine {
  constructor() {
    this.active = false;
    this.callId = null;
    this.spec = getCodecSpec('G711U');
    this.muted = false;
    this.stormyLine = false;
    this.micAvailable = false;
    this.micError = '';

    this.audioCtx = null;
    this.micStream = null;
    this.processor = null;
    this.muteGain = null;

    this.txG722 = null;
    this.rxG722 = null;
    this.txG729 = null;
    this.rxG729 = null;

    this.txSampleAccum = [];
    this.txSeq = 1000;
    this.txTs = 16000;
    this.txSsrc = 0x19941994;

    this.txPackets = 0;
    this.rxPackets = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
    this.startTimeMs = 0;

    this.txPcmChunks = [];
    this.rxPcmChunks = [];
    this.pcapPackets = [];

    this.rxNextTime = 0;
    this.burstTimer = null;

    this.onSendRtp = null;
    this.onWireLog = null;
    this.onStats = null;
    this.onVu = null;
  }

  async start({
    callId,
    codec = 'G711U',
    stormyLine = false,
    muted = false,
    initialPcapEntries = [],
    onSendRtp,
    onWireLog,
    onStats,
    onVu,
  }) {
    this.stopSyncOnly();
    this.active = true;
    this.callId = callId;
    this.spec = getCodecSpec(codec);
    this.stormyLine = Boolean(stormyLine);
    this.muted = Boolean(muted);
    this.micAvailable = false;
    this.micError = '';

    this.txG722 = new G722State();
    this.rxG722 = new G722State();
    this.txG729 = new G729State();
    this.rxG729 = new G729State();

    this.txSampleAccum = [];
    this.txSeq = Math.floor(1000 + Math.random() * 5000);
    this.txTs = 16000;
    this.txSsrc = (0x19940000 | Math.floor(Math.random() * 0xffff)) >>> 0;

    this.txPackets = 0;
    this.rxPackets = 0;
    this.txBytes = 0;
    this.rxBytes = 0;
    this.startTimeMs = Date.now();

    this.txPcmChunks = [];
    this.rxPcmChunks = [];
    this.pcapPackets = [...initialPcapEntries];
    this.rxNextTime = 0;

    this.onSendRtp = onSendRtp;
    this.onWireLog = onWireLog;
    this.onStats = onStats;
    this.onVu = onVu;

    // 1. Setup WebAudio AudioContext
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      try {
        this.audioCtx = new Ctx({ sampleRate: this.spec.sampleRate });
      } catch {
        this.audioCtx = new Ctx();
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume().catch(() => {});
      }
    }

    // 2. Request live microphone stream (graceful fallback if unavailable)
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone API unavailable in this browser');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (!this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return { micAvailable: false, micError: 'Call already ended' };
      }
      this.micStream = stream;
      this.micAvailable = true;

      if (this.audioCtx) {
        const src = this.audioCtx.createMediaStreamSource(stream);
        const proc = this.audioCtx.createScriptProcessor(2048, 1, 1);
        const zeroGain = this.audioCtx.createGain();
        zeroGain.gain.value = 0;

        proc.onaudioprocess = (ev) => {
          if (!this.active) return;
          const floatSamples = ev.inputBuffer.getChannelData(0);
          if (this.muted) {
            this.onVu?.('tx', 0);
            return;
          }
          // Convert Float32 -> Int16 at audioCtx sampleRate then resample to codec rate
          const raw16 = new Int16Array(floatSamples.length);
          let peakSq = 0;
          for (let i = 0; i < floatSamples.length; i++) {
            const s = Math.max(-1, Math.min(1, floatSamples[i]));
            raw16[i] = Math.round(s * 32767);
            peakSq += s * s;
          }
          this.onVu?.('tx', Math.min(1, Math.sqrt(peakSq / floatSamples.length) * 3.5));
          const resampled = resamplePcm16(raw16, this.audioCtx.sampleRate, this.spec.sampleRate);
          this._pushTxPcmSamples(resampled);
        };

        src.connect(proc);
        proc.connect(zeroGain);
        zeroGain.connect(this.audioCtx.destination);
        this.processor = proc;
        this.muteGain = zeroGain;
      }
    } catch (err) {
      this.micAvailable = false;
      this.micError = err?.message || 'Microphone access denied or unavailable';
    }

    return { micAvailable: this.micAvailable, micError: this.micError };
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.muted) this.onVu?.('tx', 0);
  }

  setStormyLine(stormy) {
    this.stormyLine = Boolean(stormy);
  }

  _encodeFrame(framePcm16) {
    if (this.spec.id === 'G711U') return encodeMulaw(framePcm16);
    if (this.spec.id === 'G711A') return encodeAlaw(framePcm16);
    if (this.spec.id === 'G722') return this.txG722.encode(framePcm16);
    return this.txG729.encode(framePcm16);
  }

  _decodePayload(payloadU8) {
    if (this.spec.id === 'G711U') return decodeMulaw(payloadU8);
    if (this.spec.id === 'G711A') return decodeAlaw(payloadU8);
    if (this.spec.id === 'G722') return this.rxG722.decode(payloadU8);
    return this.rxG729.decode(payloadU8);
  }

  _pushTxPcmSamples(pcm16) {
    if (!this.active) return;
    const processed = this.stormyLine
      ? applyLineStaticPcm16(pcm16, this.spec.sampleRate, this.txSeq + 1994)
      : pcm16;

    for (let i = 0; i < processed.length; i++) {
      this.txSampleAccum.push(processed[i]);
    }

    const frameSamples = this.spec.samplesPerPacket;
    while (this.txSampleAccum.length >= frameSamples) {
      const slice = new Int16Array(frameSamples);
      for (let i = 0; i < frameSamples; i++) slice[i] = this.txSampleAccum[i];
      this.txSampleAccum.splice(0, frameSamples);
      this.txPcmChunks.push(slice);

      const encoded = this._encodeFrame(slice);
      const rtp = buildRtpPacket({
        payloadType: this.spec.pt,
        sequenceNumber: this.txSeq,
        timestamp: this.txTs,
        ssrc: this.txSsrc,
        marker: this.txPackets === 0,
        payload: encoded,
      });

      this.txPackets += 1;
      this.txBytes += encoded.length;
      this.pcapPackets.push({
        payload: rtp,
        srcPort: 5004,
        dstPort: 5006,
        tsMs: Date.now(),
        fromSender: true,
      });

      if (this.txPackets <= 3 || this.txPackets % 20 === 0) {
        this.onWireLog?.({
          ts: Date.now() - this.startTimeMs,
          layer: 'RTP',
          direction: 'TX->RX',
          summary: `PT=${this.spec.pt} (${this.spec.shortLabel}) seq=${this.txSeq} ts=${this.txTs} payload=${encoded.length}B`,
        });
      }

      this.txSeq = (this.txSeq + 1) & 0xffff;
      this.txTs = (this.txTs + (this.spec.rtpTsStep || 160)) >>> 0;

      this.onSendRtp?.(rtp);
      this.onStats?.(this.getStats());
    }
  }

  /**
   * Queue a synthesized voice phrase or test tone directly into the live RTP TX stream.
   * Useful both when testing without a mic and for sending live 90s soundboard phrases!
   */
  sendSynthBurst(text = 'HELLO FROM 1994 LIVE LINE') {
    if (!this.active) return;
    const pcm = synthesizeClientSpeechPcm16(text, this.spec.sampleRate);
    this._streamPcmBurst(pcm);
  }

  sendDtmfBurst(digit = '5') {
    if (!this.active) return;
    const pair = DTMF_FREQS[String(digit)] || [770, 1336];
    const sr = this.spec.sampleRate;
    const len = Math.round(sr * 0.14);
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = Math.round(
        5200 * (Math.sin((2 * Math.PI * pair[0] * i) / sr) + Math.sin((2 * Math.PI * pair[1] * i) / sr))
      );
    }
    this._streamPcmBurst(out);
  }

  _streamPcmBurst(pcm16) {
    const chunkSamples = this.spec.samplesPerPacket * 2; // 40ms chunks
    let pos = 0;
    let peak = 0;
    for (let i = 0; i < pcm16.length; i++) peak = Math.max(peak, Math.abs(pcm16[i]));
    this.onVu?.('tx', Math.min(1, peak / 16000));

    const tick = () => {
      if (!this.active || pos >= pcm16.length) {
        this.onVu?.('tx', 0);
        return;
      }
      const end = Math.min(pcm16.length, pos + chunkSamples);
      this._pushTxPcmSamples(pcm16.subarray(pos, end));
      pos = end;
      if (pos < pcm16.length) {
        this.burstTimer = setTimeout(tick, 32);
      } else {
        this.onVu?.('tx', 0);
      }
    };
    tick();
  }

  handleIncomingRtp(rtpBytes) {
    if (!this.active) return;
    try {
      const pkt = parseRtpPacket(rtpBytes);
      this.rxPackets += 1;
      this.rxBytes += pkt.payload.length;
      this.pcapPackets.push({
        payload: rtpBytes,
        srcPort: 5006,
        dstPort: 5004,
        tsMs: Date.now(),
        fromSender: false,
      });

      if (this.rxPackets <= 3 || this.rxPackets % 20 === 0) {
        this.onWireLog?.({
          ts: Date.now() - this.startTimeMs,
          layer: 'RTP',
          direction: 'RX<-TX',
          summary: `PT=${pkt.payloadType} (${this.spec.shortLabel}) seq=${pkt.sequenceNumber} ts=${pkt.timestamp} payload=${pkt.payload.length}B`,
        });
      }

      const decoded16 = this._decodePayload(pkt.payload);
      if (decoded16.length > 0) {
        const final16 = this.stormyLine
          ? applyLineStaticPcm16(decoded16, this.spec.sampleRate, pkt.sequenceNumber + 77)
          : decoded16;
        this.rxPcmChunks.push(final16);

        let sumSq = 0;
        for (let i = 0; i < final16.length; i++) {
          const v = final16[i] / 32768;
          sumSq += v * v;
        }
        this.onVu?.('rx', Math.min(1, Math.sqrt(sumSq / final16.length) * 3.5));

        this._schedulePlayback(final16);
      }

      this.onStats?.(this.getStats());
    } catch {
      // ignore malformed RTP
    }
  }

  _schedulePlayback(pcm16) {
    if (!this.audioCtx || this.audioCtx.state === 'closed') return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    const buf = this.audioCtx.createBuffer(1, pcm16.length, this.spec.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm16.length; i++) {
      ch[i] = pcm16[i] / 32768;
    }

    const now = this.audioCtx.currentTime;
    // Maintain a small 40ms jitter buffer, clamping drift
    if (this.rxNextTime < now || this.rxNextTime > now + 0.25) {
      this.rxNextTime = now + 0.04;
    }

    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.audioCtx.destination);
    src.start(this.rxNextTime);
    this.rxNextTime += buf.duration;
  }

  getStats() {
    return {
      txPackets: this.txPackets,
      rxPackets: this.rxPackets,
      txBytes: this.txBytes,
      rxBytes: this.rxBytes,
      durationMs: this.startTimeMs ? Date.now() - this.startTimeMs : 0,
      micAvailable: this.micAvailable,
    };
  }

  stopSyncOnly() {
    this.active = false;
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = null;
    }
    if (this.processor) {
      try { this.processor.disconnect(); } catch {}
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.muteGain) {
      try { this.muteGain.disconnect(); } catch {}
      this.muteGain = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;
  }

  /**
   * Stop the live call and export recorded WAVs & Wireshark PCAP blobs.
   */
  stopAndExport({ fromNumber = '', toNumber = '', sipCallId = '', extraPcapPackets = [] } = {}) {
    const stats = this.getStats();
    const concatChunks = (chunks) => {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      if (total === 0) return new Int16Array(Math.round(this.spec.sampleRate * 0.2));
      const out = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    };

    const txPcm = concatChunks(this.txPcmChunks);
    const rxPcm = concatChunks(this.rxPcmChunks);
    const callerWavBytes = pcm16ToWavBytes(txPcm, this.spec.sampleRate);
    const replyWavBytes = pcm16ToWavBytes(rxPcm, this.spec.sampleRate);
    const pcapBytes = buildPcapBytes([...this.pcapPackets, ...extraPcapPackets]);

    const callerWavUrl = URL.createObjectURL(new Blob([callerWavBytes], { type: 'audio/wav' }));
    const replyWavUrl = URL.createObjectURL(new Blob([replyWavBytes], { type: 'audio/wav' }));
    const pcapUrl = URL.createObjectURL(new Blob([pcapBytes], { type: 'application/vnd.tcpdump.pcap' }));

    this.stopSyncOnly();

    return {
      callerWavUrl,
      replyWavUrl,
      pcapUrl,
      report: {
        status: 'OK (Live SIP + BYE Completed)',
        protocol: 'Live WebSocket SIP/SDP + RFC 3550 RTP',
        codec: this.spec.id,
        codecLabel: this.spec.label,
        payloadType: this.spec.pt,
        standard: this.spec.standard,
        bitrateKbps: this.spec.bitrateKbps,
        sampleRateHz: this.spec.sampleRate,
        rtpClockHz: this.spec.sdpClock,
        fromNumber,
        toNumber,
        callId: sipCallId,
        senderPort: 5004,
        receiverPort: 5006,
        txRtpPackets: stats.txPackets,
        txCodecBytes: stats.txBytes,
        rxRtpPackets: stats.rxPackets,
        rxCodecBytes: stats.rxBytes,
        rtpPackets: stats.txPackets + stats.rxPackets,
        rtpBytes: stats.txBytes + stats.rxBytes,
        durationMs: stats.durationMs,
      },
    };
  }
}

export const liveCallEngine = new LiveSipCallEngine();
