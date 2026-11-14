/**
 * Pure-JS ITU-T T.38 UDPTL + SIP/SDP Engine and Pure-JS SIP/RTP Bot Engine
 * for Cloudflare Workers (no OS raw UDP sockets or ffmpeg required).
 * Reuses the exact same T.4 Modified Huffman, T.30 HDLC, ASN.1 PER UDPTL,
 * RFC 3550 RTP, and G.711/G.722/G.729 codecs.
 */
import { FAX_WIDTH, encodeT4MH, decodeT4MH } from '../server/t38/t4Codec.js';
import {
  T30_FCF,
  buildCSIFrame,
  buildDISFrame,
  buildTSIFrame,
  buildDCSFrame,
  buildHDLCFrame,
  parseHDLCFrame,
} from '../server/t38/t30Frames.js';
import {
  T30_INDICATOR,
  T30_DATA,
  FIELD_TYPE,
  encodeIFP,
  encodeUDPTL,
  decodeUDPTL,
} from '../server/t38/udptl.js';
import {
  getCodecSpec,
  normalizeCodecId,
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
} from '../shared/sipCodecs.js';
import { synthesizeMessageAudio, generateBotReplyPcm } from '../server/sip/voiceSynth.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomHex(bytesLen) {
  const b = new Uint8Array(bytesLen);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function buildSipMessage(firstLine, headers, body = '') {
  const hdrLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const bodyBytes = new TextEncoder().encode(body);
  hdrLines.push(`Content-Length: ${bodyBytes.length}`);
  return new TextEncoder().encode(`${firstLine}\r\n${hdrLines.join('\r\n')}\r\n\r\n${body}`);
}

function buildT38Sdp({ sessionId, udptlPort = 5004, bitRate = 14400 }) {
  return [
    'v=0',
    `o=retrofax ${sessionId} ${sessionId} IN IP4 127.0.0.1`,
    's=RetroFax T.38 Session',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=image ${udptlPort} udptl t38`,
    'a=T38FaxVersion:0',
    `a=T38MaxBitRate:${bitRate}`,
    'a=T38FaxRateManagement:transferredTCF',
    'a=T38FaxMaxBuffer:200',
    'a=T38FaxMaxDatagram:512',
    'a=T38FaxUdpEC:t38UDPRedundancy',
    '',
  ].join('\r\n');
}

export async function executeT38TransmissionEdge({
  fromNumber,
  toNumber,
  pages,
  fine = true,
  stormyLine = false,
  targetStatus = 'online',
  pacingMs = 14,
  onEvent = () => {},
}) {
  const callId = `${crypto.randomUUID()}@retrofax.edge`;
  const branch = `z9hG4bK${randomHex(6)}`;
  const fromTag = randomHex(4);
  const toTag = randomHex(4);
  const startedAt = Date.now();
  const sSipPort = 5060;
  const rSipPort = 5062;
  const sUdpPort = 16000;
  const rUdpPort = 16002;
  const pcapPackets = [];
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

  let senderSeq = 0;
  let receiverSeq = 0;
  const senderHistory = [];
  const receiverHistory = [];
  let totalUdptlBytes = 0;
  const rxDecodedPackets = [];

  const sendUdptl = (fromSender, ifpObj, summaryLabel = '') => {
    const ifpBuf = encodeIFP(ifpObj);
    const history = fromSender ? senderHistory : receiverHistory;
    const redundancy = history.slice(-1);
    const seq = fromSender ? senderSeq++ : receiverSeq++;
    const pkt = encodeUDPTL(seq, ifpBuf, redundancy);
    history.push(ifpBuf);
    if (history.length > 4) history.shift();

    totalUdptlBytes += pkt.length;
    pcapPackets.push({
      payload: pkt,
      srcPort: fromSender ? sUdpPort : rUdpPort,
      dstPort: fromSender ? rUdpPort : sUdpPort,
      tsMs: Date.now(),
      fromSender,
    });
    if (fromSender) {
      rxDecodedPackets.push(decodeUDPTL(pkt));
    }
    emitLog('UDPTL', fromSender ? 'TX→RX' : 'RX→TX', summaryLabel || `seq=${seq} (${pkt.length}B)`, {
      seq,
      bytes: pkt.length,
    });
  };

  // 1. SIP INVITE
  onEvent({ type: 'phase', phase: 'DIALING', detail: `Dialing ${toNumber}...` });
  const inviteMsg = buildSipMessage(
    `INVITE sip:${toNumber.replace(/\s+/g, '')}@retrofax.edge SIP/2.0`,
    {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSipPort};branch=${branch}`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.edge>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.edge>`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
      'Content-Type': 'application/sdp',
    },
    buildT38Sdp({ sessionId: startedAt, udptlPort: sUdpPort })
  );
  pcapPackets.push({ payload: inviteMsg, srcPort: sSipPort, dstPort: rSipPort, tsMs: Date.now(), fromSender: true });
  emitLog('SIP', 'TX→RX', `INVITE sip:${toNumber} (SDP m=image ${sUdpPort} udptl t38)`);

  if (targetStatus === 'busy') {
    await sleep(320);
    const busyMsg = buildSipMessage('SIP/2.0 486 Busy Here', {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSipPort};branch=${branch}`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
    });
    pcapPackets.push({ payload: busyMsg, srcPort: rSipPort, dstPort: sSipPort, tsMs: Date.now(), fromSender: false });
    emitLog('SIP', 'RX→TX', '486 Busy Here (Line in use)');
    onEvent({ type: 'phase', phase: 'BUSY', detail: 'Line Busy (486)' });
    return {
      status: 'busy',
      pcapBuffer: buildPcapBytes(pcapPackets),
      logs,
      report: {
        status: 'BUSY (486 Busy Here)',
        callId,
        fromNumber,
        toNumber,
        durationMs: Date.now() - startedAt,
        udptlPackets: 0,
      },
    };
  }

  const ringMsg = buildSipMessage('SIP/2.0 180 Ringing', {
    Via: `SIP/2.0/UDP 127.0.0.1:${sSipPort};branch=${branch}`,
    'Call-ID': callId,
    CSeq: '1 INVITE',
  });
  pcapPackets.push({ payload: ringMsg, srcPort: rSipPort, dstPort: sSipPort, tsMs: Date.now(), fromSender: false });
  emitLog('SIP', 'RX→TX', '180 Ringing');
  onEvent({ type: 'phase', phase: 'RINGING', detail: `Ringing ${toNumber}...` });

  if (targetStatus === 'offline') {
    for (let r = 1; r <= 3; r++) {
      onEvent({ type: 'ring_pulse', ring: r });
      await sleep(700);
    }
    const noAnsMsg = buildSipMessage('SIP/2.0 480 Temporarily Unavailable', {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSipPort};branch=${branch}`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
    });
    pcapPackets.push({ payload: noAnsMsg, srcPort: rSipPort, dstPort: sSipPort, tsMs: Date.now(), fromSender: false });
    emitLog('SIP', 'RX→TX', '480 Temporarily Unavailable (Ring No Answer)');
    onEvent({ type: 'phase', phase: 'NO_ANSWER', detail: 'No Answer (480)' });
    return {
      status: 'no_answer',
      pcapBuffer: buildPcapBytes(pcapPackets),
      logs,
      report: {
        status: 'NO ANSWER (480 Temporarily Unavailable)',
        callId,
        fromNumber,
        toNumber,
        durationMs: Date.now() - startedAt,
        udptlPackets: 0,
      },
    };
  }

  await sleep(450);
  const okMsg = buildSipMessage(
    'SIP/2.0 200 OK',
    {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSipPort};branch=${branch}`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
      'Content-Type': 'application/sdp',
    },
    buildT38Sdp({ sessionId: startedAt + 1, udptlPort: rUdpPort })
  );
  pcapPackets.push({ payload: okMsg, srcPort: rSipPort, dstPort: sSipPort, tsMs: Date.now(), fromSender: false });
  emitLog('SIP', 'RX→TX', `200 OK (SDP m=image ${rUdpPort} udptl t38)`);
  emitLog('SIP', 'TX→RX', 'ACK (T.38 UDPTL channel established)');

  // 2. Phase B: T.30 Negotiation over UDPTL
  onEvent({ type: 'phase', phase: 'HANDSHAKE', detail: 'T.30 V.21 / V.17 Negotiating...' });
  sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.CNG }, 'T30-ind: cng (1100Hz calling tone)');
  await sleep(120);
  sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.CED }, 'T30-ind: ced (2100Hz answer tone)');
  await sleep(100);
  sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');

  const csi = buildCSIFrame(toNumber);
  const dis = buildDISFrame({ fine });
  sendUdptl(
    false,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: csi },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK, data: new Uint8Array(0) },
      ],
    },
    `T.30 CSI: "${toNumber}"`
  );
  sendUdptl(
    false,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: dis },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
      ],
    },
    `T.30 DIS: ${parseHDLCFrame(dis).detail}`
  );
  await sleep(120);

  sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');
  const tsi = buildTSIFrame(fromNumber);
  const dcs = buildDCSFrame({ fine, bitRate: 14400 });
  sendUdptl(
    true,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: tsi },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK, data: new Uint8Array(0) },
      ],
    },
    `T.30 TSI: "${fromNumber}"`
  );
  sendUdptl(
    true,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: dcs },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
      ],
    },
    `T.30 DCS: V.17 14400bps ${fine ? 'FINE' : 'STD'}`
  );
  await sleep(110);

  sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.V17_14400_LONG_TRAINING }, 'T30-ind: v17-14400-long-training');
  sendUdptl(
    true,
    {
      kind: 'data',
      dataType: T30_DATA.V17_14400,
      fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_DATA, data: new Uint8Array(512) }],
    },
    'T.30 TCF Training Check Field (512B)'
  );
  sendUdptl(
    true,
    {
      kind: 'data',
      dataType: T30_DATA.V17_14400,
      fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_SIG_END, data: new Uint8Array(0) }],
    },
    'T.30 TCF End'
  );
  await sleep(110);

  const cfr = buildHDLCFrame(T30_FCF.CFR);
  sendUdptl(
    false,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: cfr },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
      ],
    },
    'T.30 CFR (Confirmation to Receive — 14400 bps OK)'
  );
  await sleep(90);

  // 3. Phase C: Real T.4 MH scanline chunks over ASN.1 PER UDPTL
  const receivedPages = [];
  let totalT4Bytes = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    onEvent({
      type: 'phase',
      phase: 'TRANSMITTING',
      page: pageIdx + 1,
      totalPages: pages.length,
      detail: `Sending Page ${pageIdx + 1}/${pages.length} @ 14400 bps`,
    });

    sendUdptl(
      true,
      { kind: 'indicator', indicator: T30_INDICATOR.V17_14400_LONG_TRAINING },
      `T30-ind: v17-14400-long-training (Page ${pageIdx + 1})`
    );

    const t4Stream = encodeT4MH(page.pixels, page.width || FAX_WIDTH, page.height, { lsbFirst: true });
    const wireStream = Buffer.from(t4Stream);
    if (stormyLine && wireStream.length > 400) {
      const numGlitches = Math.min(4, Math.max(1, Math.floor(wireStream.length / 8000)));
      for (let g = 0; g < numGlitches; g++) {
        const offset = 120 + Math.floor(Math.random() * (wireStream.length - 240));
        wireStream[offset] ^= 0x07;
      }
    }

    const CHUNK_SIZE = 480;
    const totalChunks = Math.ceil(wireStream.length / CHUNK_SIZE);
    const chunkDelay = pacingMs > 0 ? Math.min(pacingMs, Math.max(2, Math.floor(900 / Math.max(1, totalChunks)))) : 0;
    const progressStep = Math.max(1, Math.floor(totalChunks / 16));
    const pageStartRxIdx = rxDecodedPackets.length;

    for (let c = 0; c < totalChunks; c++) {
      const chunk = wireStream.subarray(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
      totalT4Bytes += chunk.length;
      const pct = Math.round(((c + 1) / totalChunks) * 100);
      const logEvery = c === 0 || c === totalChunks - 1 || c % Math.max(8, progressStep * 2) === 0;

      sendUdptl(
        true,
        {
          kind: 'data',
          dataType: T30_DATA.V17_14400,
          fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_DATA, data: chunk }],
        },
        logEvery ? `T.4 MH Page ${pageIdx + 1} chunk ${c + 1}/${totalChunks} (${chunk.length}B, ${pct}%)` : ''
      );

      if (c === 0 || c === totalChunks - 1 || c % progressStep === 0) {
        onEvent({
          type: 'progress',
          page: pageIdx + 1,
          totalPages: pages.length,
          pageProgress: (c + 1) / totalChunks,
          overallProgress: (pageIdx + (c + 1) / totalChunks) / pages.length,
          udptlPackets: senderSeq + receiverSeq,
        });
      }
      if (chunkDelay > 0) await sleep(chunkDelay);
    }

    sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V17_14400,
        fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_SIG_END, data: new Uint8Array(0) }],
      },
      `T.4 Page ${pageIdx + 1} t4-non-ecm-sig-end`
    );

    const rxT4Chunks = [];
    for (let i = pageStartRxIdx; i < rxDecodedPackets.length; i++) {
      const p = rxDecodedPackets[i];
      if (p.primary?.kind === 'data' && p.primary.dataType === T30_DATA.V17_14400) {
        for (const f of p.primary.fields) {
          if (f.fieldType === FIELD_TYPE.T4_NON_ECM_DATA && f.data) rxT4Chunks.push(f.data);
        }
      }
    }
    const assembled = Buffer.concat(rxT4Chunks);
    const decoded = decodeT4MH(assembled, page.width || FAX_WIDTH, { lsbFirst: true });
    receivedPages.push(decoded);

    const isLast = pageIdx === pages.length - 1;
    const postMsg = buildHDLCFrame(isLast ? T30_FCF.EOP : T30_FCF.MPS);
    sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: postMsg },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
        ],
      },
      isLast ? 'T.30 EOP (End of Procedure)' : 'T.30 MPS (Multi-Page Signal)'
    );

    const mcf = buildHDLCFrame(T30_FCF.MCF);
    sendUdptl(
      false,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: mcf },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
        ],
      },
      `T.30 MCF (Page ${pageIdx + 1} Confirmed — ${decoded.height} scanlines decoded)`
    );
    await sleep(60);
  }

  // 4. Phase E: DCN + SIP BYE
  sendUdptl(
    true,
    {
      kind: 'data',
      dataType: T30_DATA.V21,
      fields: [
        { fieldType: FIELD_TYPE.HDLC_DATA, data: buildHDLCFrame(T30_FCF.DCN) },
        { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: new Uint8Array(0) },
      ],
    },
    'T.30 DCN (Disconnect)'
  );
  emitLog('SIP', 'TX→RX', 'BYE');
  emitLog('SIP', 'RX→TX', '200 OK (Session Closed)');
  onEvent({ type: 'phase', phase: 'COMPLETED', detail: 'Fax Sent (MCF Confirmed)' });

  return {
    status: 'ok',
    receivedPages,
    pcapBuffer: buildPcapBytes(pcapPackets),
    logs,
    report: {
      status: 'OK (MCF Confirmed)',
      protocol: 'ITU-T T.38 UDPTL / SIP SDP (Cloudflare Edge)',
      coding: 'T.4 1D Modified Huffman (1728px)',
      modulation: 'V.17 14400 bps',
      resolution: fine ? 'FINE (204x196 dpi)' : 'STANDARD (204x98 dpi)',
      callId,
      fromNumber,
      toNumber,
      pages: receivedPages.length,
      t4Bytes: totalT4Bytes,
      udptlPackets: senderSeq + receiverSeq,
      udptlBytes: totalUdptlBytes,
      rxPacketsDecoded: rxDecodedPackets.length,
      scanlineErrors: receivedPages.reduce((acc, p) => acc + p.errors, 0),
      durationMs: Date.now() - startedAt,
      stormyLine,
    },
  };
}

function encodeCodecFrame(codecId, pcmFrame, encState) {
  if (codecId === 'G711U') return encodeMulaw(pcmFrame);
  if (codecId === 'G711A') return encodeAlaw(pcmFrame);
  if (codecId === 'G722') return encState.encode(pcmFrame);
  if (codecId === 'G729') return encState.encode(pcmFrame);
  return encodeMulaw(pcmFrame);
}

function decodeCodecFrame(codecId, bytes, decState) {
  if (codecId === 'G711U') return decodeMulaw(bytes);
  if (codecId === 'G711A') return decodeAlaw(bytes);
  if (codecId === 'G722') return decState.decode(bytes);
  if (codecId === 'G729') return decState.decode(bytes);
  return decodeMulaw(bytes);
}

/**
 * Pure-JS SIP/SDP + RFC 3550 RTP voice exchange for Automated Bots on Cloudflare Edge.
 */
export async function executeSipVoiceCallEdge({
  fromNumber,
  toNumber,
  codec = 'G711U',
  ttsText = 'HELLO FROM 1994 RETROFAX',
  targetStatus = 'online',
  stormyLine = false,
  botId = 'bot-echo',
  pacingMs = 6,
  onEvent = () => {},
}) {
  const codecId = normalizeCodecId(codec);
  const spec = getCodecSpec(codecId);
  const callId = `${crypto.randomUUID()}@retrofax.edge`;
  const startedAt = Date.now();
  const logs = [];
  const pcapPackets = [];
  let rtpPacketsTotal = 0;

  const emitLog = (layer, direction, summary, extra = {}) => {
    const entry = { ts: Date.now() - startedAt, layer, direction, summary, ...extra };
    logs.push(entry);
    onEvent({ type: 't38_log', entry });
  };

  onEvent({ type: 'phase', phase: 'DIALING', detail: `SIP INVITE (${spec.label}) → ${toNumber}` });
  emitLog('SIP', 'TX→RX', `INVITE sip:${toNumber} (SDP m=audio 5004 RTP/AVP ${spec.pt} a=rtpmap:${spec.pt} ${spec.sdpName}/${spec.sdpClock})`);

  if (targetStatus === 'busy') {
    await sleep(300);
    emitLog('SIP', 'RX→TX', 'SIP/2.0 486 Busy Here');
    onEvent({ type: 'phase', phase: 'BUSY', detail: 'Line Busy (SIP 486)' });
    return {
      status: 'busy',
      pcapBuffer: buildPcapBytes(pcapPackets),
      logs,
      report: { status: 'BUSY (486 Busy Here)', codec: codecId, toNumber, callId, rtpPackets: 0 },
    };
  }

  emitLog('SIP', 'RX→TX', 'SIP/2.0 180 Ringing');
  onEvent({ type: 'phase', phase: 'RINGING', detail: `Ringing ${toNumber}...` });

  if (targetStatus === 'offline') {
    for (let r = 1; r <= 3; r++) {
      onEvent({ type: 'ring_pulse', ring: r });
      await sleep(650);
    }
    emitLog('SIP', 'RX→TX', 'SIP/2.0 480 Temporarily Unavailable (Ring No Answer)');
    onEvent({ type: 'phase', phase: 'NO_ANSWER', detail: 'No Answer (SIP 480)' });
    return {
      status: 'no_answer',
      pcapBuffer: buildPcapBytes(pcapPackets),
      logs,
      report: { status: 'NO ANSWER (480 Temporarily Unavailable)', codec: codecId, toNumber, callId, rtpPackets: 0 },
    };
  }

  await sleep(350);
  emitLog('SIP', 'RX→TX', `SIP/2.0 200 OK (SDP m=audio 5006 RTP/AVP ${spec.pt} a=rtpmap:${spec.pt} ${spec.sdpName}/${spec.sdpClock})`);
  emitLog('SIP', 'TX→RX', 'ACK (RTP Media Stream Active)');
  onEvent({ type: 'phase', phase: 'VOICE_ACTIVE', detail: `${spec.shortLabel} RTP Stream Active` });

  // Synthesize caller audio -> resample -> encode -> RTP -> decode -> WAV
  const callerRaw16k = synthesizeMessageAudio(ttsText, 16000);
  let callerCodecPcm = resamplePcm16(callerRaw16k, 16000, spec.sampleRate);
  if (stormyLine) callerCodecPcm = applyLineStaticPcm16(callerCodecPcm, spec.sampleRate, 1994);

  const encStateTx = codecId === 'G722' ? new G722State() : codecId === 'G729' ? new G729State() : null;
  const decStateTx = codecId === 'G722' ? new G722State() : codecId === 'G729' ? new G729State() : null;

  const totalTxFrames = Math.ceil(callerCodecPcm.length / spec.samplesPerPacket);
  const decodedTxChunks = [];
  let txSeq = 1;
  let txTs = 160;

  for (let i = 0; i < totalTxFrames; i++) {
    const start = i * spec.samplesPerPacket;
    const frame = new Int16Array(spec.samplesPerPacket);
    frame.set(callerCodecPcm.subarray(start, start + spec.samplesPerPacket));
    const encoded = encodeCodecFrame(codecId, frame, encStateTx);
    const pkt = buildRtpPacket({
      payloadType: spec.pt,
      sequenceNumber: txSeq++,
      timestamp: txTs,
      ssrc: 0x1994a001,
      marker: i === 0,
      payload: encoded,
    });
    txTs += spec.rtpTsStep;
    rtpPacketsTotal++;
    pcapPackets.push({ payload: pkt, srcPort: 5004, dstPort: 5006, tsMs: Date.now(), fromSender: true });

    const parsed = parseRtpPacket(pkt);
    decodedTxChunks.push(decodeCodecFrame(codecId, parsed.payload, decStateTx));

    if (i === 0 || i === totalTxFrames - 1 || i % 10 === 0) {
      emitLog('RTP', 'TX→RX', `PT=${spec.pt} (${spec.shortLabel}) seq=${parsed.sequenceNumber} ts=${parsed.timestamp} len=${parsed.payload.length}B`);
      onEvent({
        type: 'progress',
        overallProgress: ((i + 1) / totalTxFrames) * 0.5,
        rtpPackets: rtpPacketsTotal,
      });
    }
    if (pacingMs > 0) await sleep(pacingMs);
  }

  const totalTxLen = decodedTxChunks.reduce((s, c) => s + c.length, 0);
  const calleeReceivedPcm = new Int16Array(totalTxLen);
  let off = 0;
  for (const c of decodedTxChunks) {
    calleeReceivedPcm.set(c, off);
    off += c.length;
  }

  // Generate Bot Reply Audio -> encode -> RTP -> decode -> WAV
  const replyRaw = generateBotReplyPcm({
    botId: botId || 'bot-echo',
    callerNumber: fromNumber,
    callerDecodedPcm: calleeReceivedPcm,
    sampleRate: spec.sampleRate,
  });
  const replyCodecPcm = stormyLine ? applyLineStaticPcm16(replyRaw, spec.sampleRate, 1995) : replyRaw;

  const encStateRx = codecId === 'G722' ? new G722State() : codecId === 'G729' ? new G729State() : null;
  const decStateRx = codecId === 'G722' ? new G722State() : codecId === 'G729' ? new G729State() : null;
  const totalRxFrames = Math.ceil(replyCodecPcm.length / spec.samplesPerPacket);
  const decodedRxChunks = [];
  let rxSeq = 1;
  let rxTs = 160;

  for (let i = 0; i < totalRxFrames; i++) {
    const start = i * spec.samplesPerPacket;
    const frame = new Int16Array(spec.samplesPerPacket);
    frame.set(replyCodecPcm.subarray(start, start + spec.samplesPerPacket));
    const encoded = encodeCodecFrame(codecId, frame, encStateRx);
    const pkt = buildRtpPacket({
      payloadType: spec.pt,
      sequenceNumber: rxSeq++,
      timestamp: rxTs,
      ssrc: 0x1994b002,
      marker: i === 0,
      payload: encoded,
    });
    rxTs += spec.rtpTsStep;
    rtpPacketsTotal++;
    pcapPackets.push({ payload: pkt, srcPort: 5006, dstPort: 5004, tsMs: Date.now(), fromSender: false });

    const parsed = parseRtpPacket(pkt);
    decodedRxChunks.push(decodeCodecFrame(codecId, parsed.payload, decStateRx));

    if (i === 0 || i === totalRxFrames - 1 || i % 10 === 0) {
      emitLog('RTP', 'RX→TX', `PT=${spec.pt} (${spec.shortLabel}) seq=${parsed.sequenceNumber} ts=${parsed.timestamp} len=${parsed.payload.length}B`);
      onEvent({
        type: 'progress',
        overallProgress: 0.5 + ((i + 1) / totalRxFrames) * 0.5,
        rtpPackets: rtpPacketsTotal,
      });
    }
    if (pacingMs > 0) await sleep(pacingMs);
  }

  const totalRxLen = decodedRxChunks.reduce((s, c) => s + c.length, 0);
  const callerReturnPcm = new Int16Array(totalRxLen);
  off = 0;
  for (const c of decodedRxChunks) {
    callerReturnPcm.set(c, off);
    off += c.length;
  }

  emitLog('SIP', 'TX→RX', 'BYE');
  emitLog('SIP', 'RX→TX', 'SIP/2.0 200 OK (Voice Session Closed)');
  onEvent({ type: 'phase', phase: 'COMPLETED', detail: 'SIP 200 OK / BYE' });

  return {
    status: 'ok',
    calleeReceivedWav: pcm16ToWavBytes(calleeReceivedPcm, spec.sampleRate),
    callerReturnWav: pcm16ToWavBytes(callerReturnPcm, spec.sampleRate),
    pcapBuffer: buildPcapBytes(pcapPackets),
    logs,
    report: {
      status: 'OK (200 OK / BYE)',
      protocol: 'SIP/SDP + RFC 3550 RTP (Cloudflare Edge)',
      codec: spec.id,
      codecLabel: spec.label,
      payloadType: spec.pt,
      sampleRate: spec.sampleRate,
      bitrateKbps: spec.bitrateKbps,
      callId,
      fromNumber,
      toNumber,
      rtpPackets: rtpPacketsTotal,
      durationMs: Date.now() - startedAt,
      stormyLine,
    },
  };
}
