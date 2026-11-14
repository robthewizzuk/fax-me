import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { PcapWriter } from '../t38/pcapWriter.js';
import {
  SIP_CODECS,
  getCodecSpec,
  encodeAudioForCodec,
  decodeAudioForCodec,
  pcm16ToWav,
} from './codecs.js';
import { buildRtpPacket, parseRtpPacket } from './rtp.js';
import { generateBotReplyPcm, applyLineStatic } from './voiceSynth.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bindLocalUdp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeListener('error', reject);
      resolve({ sock, port: sock.address().port });
    });
  });
}

function buildSipMessage(firstLine, headers, body = '') {
  const hdrLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const bodyBuf = Buffer.from(body, 'utf8');
  hdrLines.push(`Content-Length: ${bodyBuf.length}`);
  return Buffer.from(`${firstLine}\r\n${hdrLines.join('\r\n')}\r\n\r\n${body}`, 'utf8');
}

function buildAudioSdpOffer({ sessionId, ip = '127.0.0.1', rtpPort, preferredCodecId = 'G711U' }) {
  const pref = getCodecSpec(preferredCodecId);
  const all = [pref, ...Object.values(SIP_CODECS).filter((c) => c.id !== pref.id)];
  const ptList = all.map((c) => c.pt).join(' ');
  const rtpmapLines = all.map((c) => `a=rtpmap:${c.pt} ${c.sdpName}/${c.sdpClock}`);
  if (all.some((c) => c.pt === 18)) {
    rtpmapLines.push('a=fmtp:18 annexb=no');
  }
  return [
    'v=0',
    `o=retrofax ${sessionId} ${sessionId} IN IP4 ${ip}`,
    `s=RetroFax SIP Voice (${pref.sdpName})`,
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP ${ptList}`,
    ...rtpmapLines,
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}

function buildAudioSdpAnswer({ sessionId, ip = '127.0.0.1', rtpPort, negotiatedCodecId }) {
  const c = getCodecSpec(negotiatedCodecId);
  const lines = [
    'v=0',
    `o=retrofax ${sessionId} ${sessionId} IN IP4 ${ip}`,
    `s=RetroFax SIP Voice (${c.sdpName})`,
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP ${c.pt}`,
    `a=rtpmap:${c.pt} ${c.sdpName}/${c.sdpClock}`,
  ];
  if (c.pt === 18) lines.push('a=fmtp:18 annexb=no');
  lines.push('a=ptime:20', 'a=sendrecv', '');
  return lines.join('\r\n');
}

/**
 * Execute a genuine real-time SIP/SDP + RFC 3550 RTP voice call over OS UDP sockets
 * using real ITU-T G.711 PCMU/PCMA, G.722 SB-ADPCM, or G.729A CS-ACELP codecs.
 */
export async function executeSipVoiceCall({
  fromNumber,
  toNumber,
  codec = 'G711U',
  callerPcm16,
  callerSampleRate = 16000,
  targetStatus = 'online', // 'online' | 'offline' | 'busy'
  stormyLine = false,
  botId = null,
  replyPcm16 = null,
  replySampleRate = 16000,
  pacingMs = 10,
  onEvent = () => {},
}) {
  const codecSpec = getCodecSpec(codec);
  const callId = `${crypto.randomUUID()}@retrofax.local`;
  const branch = `z9hG4bK${crypto.randomBytes(6).toString('hex')}`;
  const fromTag = crypto.randomBytes(4).toString('hex');
  const toTag = crypto.randomBytes(4).toString('hex');
  const startedAt = Date.now();
  const pcap = new PcapWriter();
  const logs = [];

  const emitLog = (layer, direction, summary, extra = {}) => {
    const entry = {
      ts: Date.now() - startedAt,
      layer,
      direction,
      summary,
      ...extra,
    };
    logs.push(entry);
    onEvent({ type: 't38_log', entry });
  };

  const sSip = await bindLocalUdp();
  const rSip = await bindLocalUdp();
  const sRtp = await bindLocalUdp();
  const rRtp = await bindLocalUdp();

  const sendSipUdp = (fromSock, dstPort, buf, fromSender) =>
    new Promise((resolve) => {
      const srcPort = fromSock.address().port;
      pcap.addUdpPacket({ srcPort, dstPort, payload: buf, fromSender });
      fromSock.send(buf, dstPort, '127.0.0.1', () => resolve());
    });

  const waitSipOn = (sock) =>
    new Promise((resolve) => {
      sock.once('message', (msg) => resolve(msg.toString('utf8')));
    });

  const rxReceivedRtp = []; // packets received on callee's rRtp socket
  const txReceivedRtp = []; // return packets received on caller's sRtp socket

  rRtp.sock.on('message', (msg) => {
    try {
      rxReceivedRtp.push(parseRtpPacket(msg));
    } catch {
      // ignore non-RTP
    }
  });
  sRtp.sock.on('message', (msg) => {
    try {
      txReceivedRtp.push(parseRtpPacket(msg));
    } catch {
      // ignore non-RTP
    }
  });

  try {
    // 1. SIP INVITE with multi-codec Audio SDP Offer
    onEvent({ type: 'phase', phase: 'DIALING', detail: `SIP INVITE (${codecSpec.shortLabel}) -> ${toNumber}` });
    const sdpOffer = buildAudioSdpOffer({
      sessionId: startedAt,
      rtpPort: sRtp.port,
      preferredCodecId: codecSpec.id,
    });
    const inviteMsg = buildSipMessage(
      `INVITE sip:${toNumber.replace(/\s+/g, '')}@retrofax.local SIP/2.0`,
      {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Contact: `<sip:caller@127.0.0.1:${sSip.port}>`,
        'Content-Type': 'application/sdp',
      },
      sdpOffer
    );

    const rxSipWait = waitSipOn(rSip.sock);
    await sendSipUdp(sSip.sock, rSip.port, inviteMsg, true);
    await rxSipWait;
    emitLog('SIP', 'TX→RX', `INVITE sip:${toNumber} (SDP m=audio ${sRtp.port} RTP/AVP ${codecSpec.pt} [pref=${codecSpec.sdpName}])`);

    // 486 Busy Here
    if (targetStatus === 'busy') {
      await sleep(400);
      const busyMsg = buildSipMessage('SIP/2.0 486 Busy Here', {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
      });
      const busyWait = waitSipOn(sSip.sock);
      await sendSipUdp(rSip.sock, sSip.port, busyMsg, false);
      await busyWait;
      emitLog('SIP', 'RX→TX', '486 Busy Here (Handset in use)');
      onEvent({ type: 'phase', phase: 'BUSY', detail: 'Line Busy (SIP 486)' });
      return {
        status: 'busy',
        pcapBuffer: pcap.toBuffer(),
        logs,
        report: {
          status: 'BUSY (486 Busy Here)',
          protocol: 'SIP/SDP + RFC 3550 RTP',
          codec: codecSpec.id,
          codecLabel: codecSpec.label,
          payloadType: codecSpec.pt,
          callId,
          fromNumber,
          toNumber,
          durationMs: Date.now() - startedAt,
          rtpPackets: 0,
        },
      };
    }

    // 180 Ringing
    const ringMsg = buildSipMessage('SIP/2.0 180 Ringing', {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
    });
    const ringWait = waitSipOn(sSip.sock);
    await sendSipUdp(rSip.sock, sSip.port, ringMsg, false);
    await ringWait;
    emitLog('SIP', 'RX→TX', '180 Ringing');
    onEvent({ type: 'phase', phase: 'RINGING', detail: `Ringing ${toNumber}...` });

    // 480 Ring No Answer
    if (targetStatus === 'offline') {
      for (let r = 1; r <= 3; r++) {
        onEvent({ type: 'ring_pulse', ring: r });
        await sleep(750);
      }
      const noAnsMsg = buildSipMessage('SIP/2.0 480 Temporarily Unavailable', {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Reason: 'Q.850;cause=19;text="No Answer from User"',
      });
      const noAnsWait = waitSipOn(sSip.sock);
      await sendSipUdp(rSip.sock, sSip.port, noAnsMsg, false);
      await noAnsWait;
      emitLog('SIP', 'RX→TX', '480 Temporarily Unavailable (Ring No Answer)');
      onEvent({ type: 'phase', phase: 'NO_ANSWER', detail: 'No Answer (SIP 480)' });
      return {
        status: 'no_answer',
        pcapBuffer: pcap.toBuffer(),
        logs,
        report: {
          status: 'NO ANSWER (480 Temporarily Unavailable)',
          protocol: 'SIP/SDP + RFC 3550 RTP',
          codec: codecSpec.id,
          codecLabel: codecSpec.label,
          payloadType: codecSpec.pt,
          callId,
          fromNumber,
          toNumber,
          durationMs: Date.now() - startedAt,
          rtpPackets: 0,
        },
      };
    }

    // 200 OK + Negotiated Audio Codec SDP Answer + ACK
    await sleep(420);
    const sdpAnswer = buildAudioSdpAnswer({
      sessionId: startedAt + 1,
      rtpPort: rRtp.port,
      negotiatedCodecId: codecSpec.id,
    });
    const okMsg = buildSipMessage(
      'SIP/2.0 200 OK',
      {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Contact: `<sip:callee@127.0.0.1:${rSip.port}>`,
        'Content-Type': 'application/sdp',
      },
      sdpAnswer
    );
    const okWait = waitSipOn(sSip.sock);
    await sendSipUdp(rSip.sock, sSip.port, okMsg, false);
    await okWait;
    emitLog('SIP', 'RX→TX', `200 OK (SDP m=audio ${rRtp.port} RTP/AVP ${codecSpec.pt} ${codecSpec.sdpName}/${codecSpec.sdpClock})`);

    const ackMsg = buildSipMessage(`ACK sip:callee@127.0.0.1:${rSip.port} SIP/2.0`, {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}-ack`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '1 ACK',
    });
    const ackWait = waitSipOn(rSip.sock);
    await sendSipUdp(sSip.sock, rSip.port, ackMsg, true);
    await ackWait;
    emitLog('SIP', 'TX→RX', `ACK (RTP media connected: ${codecSpec.label} @ ${codecSpec.bitrateKbps} kbps)`);

    // 2. Encode caller audio using selected codec & stream 20ms RTP packets TX -> RX
    onEvent({
      type: 'phase',
      phase: 'VOICE_ACTIVE',
      detail: `Streaming ${codecSpec.shortLabel} RTP (PT=${codecSpec.pt})...`,
    });

    const callerPreparedPcm = stormyLine
      ? applyLineStatic(callerPcm16, callerSampleRate)
      : callerPcm16;

    const encodedCaller = await encodeAudioForCodec(callerPreparedPcm, callerSampleRate, codecSpec.id);
    const pktPayloadBytes = codecSpec.bytesPerPacket;
    const totalTxPackets = Math.max(1, Math.ceil(encodedCaller.encoded.length / pktPayloadBytes));
    const tsStep = codecSpec.rtpTsStep || codecSpec.samplesPerPacket; // 160 ticks/20ms for all four codecs per RFC 3551

    const txSsrc = crypto.randomBytes(4).readUInt32BE(0);
    let txSeq = crypto.randomInt(100, 4000);
    let txTs = crypto.randomInt(1000, 80000);
    let totalRtpBytes = 0;

    const sendRtpUdp = (fromSender, payload, seq, ts, ssrc, marker, summaryLabel = '') =>
      new Promise((resolve) => {
        const rtpBuf = buildRtpPacket({
          payloadType: codecSpec.pt,
          sequenceNumber: seq,
          timestamp: ts,
          ssrc,
          marker,
          payload,
        });
        totalRtpBytes += rtpBuf.length;
        const sock = fromSender ? sRtp.sock : rRtp.sock;
        const srcPort = fromSender ? sRtp.port : rRtp.port;
        const dstPort = fromSender ? rRtp.port : sRtp.port;
        pcap.addUdpPacket({ srcPort, dstPort, payload: rtpBuf, fromSender });
        sock.send(rtpBuf, dstPort, '127.0.0.1', () => {
          if (summaryLabel) {
            emitLog('RTP', fromSender ? 'TX→RX' : 'RX→TX', summaryLabel, {
              seq,
              ts,
              pt: codecSpec.pt,
              bytes: rtpBuf.length,
            });
          }
          resolve();
        });
      });

    const txDelay = pacingMs > 0 ? Math.min(pacingMs, Math.max(2, Math.floor(850 / totalTxPackets))) : 0;
    const txLogEvery = Math.max(1, Math.floor(totalTxPackets / 6));

    for (let i = 0; i < totalTxPackets; i++) {
      let chunk = encodedCaller.encoded.subarray(i * pktPayloadBytes, (i + 1) * pktPayloadBytes);
      if (chunk.length < pktPayloadBytes) {
        const padded = Buffer.alloc(pktPayloadBytes, codecSpec.pt === 0 ? 0xff : codecSpec.pt === 8 ? 0xd5 : 0x00);
        chunk.copy(padded);
        chunk = padded;
      }
      const shouldLog = i === 0 || i === totalTxPackets - 1 || i % txLogEvery === 0;
      const summary = shouldLog
        ? `PT=${codecSpec.pt} (${codecSpec.sdpName}) seq=${txSeq} ts=${txTs} payload=${chunk.length}B${i === 0 ? ' [M]' : ''}`
        : '';
      await sendRtpUdp(true, chunk, txSeq, txTs, txSsrc, i === 0, summary);
      txSeq = (txSeq + 1) & 0xffff;
      txTs = (txTs + tsStep) >>> 0;

      if (i === 0 || i === totalTxPackets - 1 || i % txLogEvery === 0) {
        onEvent({
          type: 'progress',
          overallProgress: ((i + 1) / totalTxPackets) * 0.5,
          rtpPackets: i + 1,
        });
      }
      if (txDelay > 0) await sleep(txDelay);
    }

    await sleep(30); // allow UDP socket loop flush

    // Reassemble ONLY actual UDP-received caller RTP packets at rRtp!
    rxReceivedRtp.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const rxCodecBytes = Buffer.concat(rxReceivedRtp.map((p) => p.payload));
    const decodedAtCallee = await decodeAudioForCodec(rxCodecBytes, codecSpec.id);
    const calleeReceivedWav = pcm16ToWav(decodedAtCallee.pcm16, decodedAtCallee.sampleRate);

    // 3. Return RTP voice stream RX -> TX (bot reply / custom reply / echo loopback through the same codec!)
    let sourceReplyPcm = replyPcm16;
    let sourceReplySr = replySampleRate;
    if (!sourceReplyPcm) {
      sourceReplySr = codecSpec.sampleRate;
      sourceReplyPcm = generateBotReplyPcm({
        botId: botId || 'bot-echo',
        callerNumber: fromNumber,
        callerDecodedPcm: decodedAtCallee.pcm16,
        sampleRate: sourceReplySr,
      });
    }
    if (stormyLine) {
      sourceReplyPcm = applyLineStatic(sourceReplyPcm, sourceReplySr);
    }

    const encodedReply = await encodeAudioForCodec(sourceReplyPcm, sourceReplySr, codecSpec.id);
    const totalRxReturnPackets = Math.max(1, Math.ceil(encodedReply.encoded.length / pktPayloadBytes));
    const rxSsrc = crypto.randomBytes(4).readUInt32BE(0);
    let rxSeq = crypto.randomInt(100, 4000);
    let rxTs = crypto.randomInt(1000, 80000);
    const rxDelay = pacingMs > 0 ? Math.min(pacingMs, Math.max(2, Math.floor(850 / totalRxReturnPackets))) : 0;
    const rxLogEvery = Math.max(1, Math.floor(totalRxReturnPackets / 6));

    for (let i = 0; i < totalRxReturnPackets; i++) {
      let chunk = encodedReply.encoded.subarray(i * pktPayloadBytes, (i + 1) * pktPayloadBytes);
      if (chunk.length < pktPayloadBytes) {
        const padded = Buffer.alloc(pktPayloadBytes, codecSpec.pt === 0 ? 0xff : codecSpec.pt === 8 ? 0xd5 : 0x00);
        chunk.copy(padded);
        chunk = padded;
      }
      const shouldLog = i === 0 || i === totalRxReturnPackets - 1 || i % rxLogEvery === 0;
      const summary = shouldLog
        ? `PT=${codecSpec.pt} (${codecSpec.sdpName}) seq=${rxSeq} ts=${rxTs} payload=${chunk.length}B${i === 0 ? ' [M]' : ''}`
        : '';
      await sendRtpUdp(false, chunk, rxSeq, rxTs, rxSsrc, i === 0, summary);
      rxSeq = (rxSeq + 1) & 0xffff;
      rxTs = (rxTs + tsStep) >>> 0;

      if (i === 0 || i === totalRxReturnPackets - 1 || i % rxLogEvery === 0) {
        onEvent({
          type: 'progress',
          overallProgress: 0.5 + ((i + 1) / totalRxReturnPackets) * 0.5,
          rtpPackets: totalTxPackets + i + 1,
        });
      }
      if (rxDelay > 0) await sleep(rxDelay);
    }

    await sleep(30);

    // Reassemble ONLY actual UDP-received return RTP packets at sRtp!
    txReceivedRtp.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const returnCodecBytes = Buffer.concat(txReceivedRtp.map((p) => p.payload));
    const decodedAtCaller = await decodeAudioForCodec(returnCodecBytes, codecSpec.id);
    const callerReturnWav = pcm16ToWav(decodedAtCaller.pcm16, decodedAtCaller.sampleRate);

    // 4. SIP BYE -> 200 OK
    const byeMsg = buildSipMessage(`BYE sip:callee@127.0.0.1:${rSip.port} SIP/2.0`, {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}-bye`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '2 BYE',
    });
    const byeWait = waitSipOn(rSip.sock);
    await sendSipUdp(sSip.sock, rSip.port, byeMsg, true);
    await byeWait;
    emitLog('SIP', 'TX→RX', 'BYE');

    const byeOk = buildSipMessage('SIP/2.0 200 OK', {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}-bye`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '2 BYE',
    });
    const byeOkWait = waitSipOn(sSip.sock);
    await sendSipUdp(rSip.sock, sSip.port, byeOk, false);
    await byeOkWait;
    emitLog('SIP', 'RX→TX', '200 OK (Voice Session Closed)');

    const durationMs = Date.now() - startedAt;
    onEvent({ type: 'phase', phase: 'COMPLETED', detail: `Call Done (${codecSpec.shortLabel})` });

    return {
      status: 'ok',
      codecSpec,
      calleeReceivedWav, // What callee received over UDP + decoded
      callerReturnWav,   // What caller received back (reply / echo) over UDP + decoded
      calleeDecodedPcm: decodedAtCallee.pcm16,
      callerReturnPcm: decodedAtCaller.pcm16,
      sampleRate: codecSpec.sampleRate,
      pcapBuffer: pcap.toBuffer(),
      logs,
      report: {
        status: 'OK (200 OK + BYE Completed)',
        protocol: 'SIP/SDP + RFC 3550 RTP',
        codec: codecSpec.id,
        codecLabel: codecSpec.label,
        standard: codecSpec.standard,
        payloadType: codecSpec.pt,
        sampleRateHz: codecSpec.sampleRate,
        rtpClockHz: codecSpec.sdpClock,
        bitrateKbps: codecSpec.bitrateKbps,
        bytesPerPacket: codecSpec.bytesPerPacket,
        callId,
        fromNumber,
        toNumber,
        txRtpPackets: rxReceivedRtp.length,
        rxRtpPackets: txReceivedRtp.length,
        rtpPackets: rxReceivedRtp.length + txReceivedRtp.length,
        rtpBytes: totalRtpBytes,
        txCodecBytes: rxCodecBytes.length,
        rxCodecBytes: returnCodecBytes.length,
        durationMs,
        audioDurationSec: Number((decodedAtCaller.pcm16.length / codecSpec.sampleRate).toFixed(2)),
        stormyLine,
        senderPort: sRtp.port,
        receiverPort: rRtp.port,
      },
    };
  } finally {
    sSip.sock.close();
    rSip.sock.close();
    sRtp.sock.close();
    rRtp.sock.close();
  }
}
