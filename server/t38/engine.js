import dgram from 'node:dgram';
import crypto from 'node:crypto';
import {
  FAX_WIDTH,
  encodeT4MH,
  decodeT4MH,
} from './t4Codec.js';
import {
  T30_FCF,
  buildCSIFrame,
  buildDISFrame,
  buildTSIFrame,
  buildDCSFrame,
  buildHDLCFrame,
  parseHDLCFrame,
} from './t30Frames.js';
import {
  T30_INDICATOR,
  T30_DATA,
  FIELD_TYPE,
  encodeIFP,
  encodeUDPTL,
  decodeUDPTL,
} from './udptl.js';
import { PcapWriter } from './pcapWriter.js';

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

function buildT38Sdp({ sessionId, ip = '127.0.0.1', udptlPort, bitRate = 14400 }) {
  return [
    'v=0',
    `o=retrofax ${sessionId} ${sessionId} IN IP4 ${ip}`,
    's=RetroFax T.38 Session',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=image ${udptlPort} udptl t38`,
    'a=T38FaxVersion:0',
    `a=T38MaxBitRate:${bitRate}`,
    'a=T38FaxFillBitRemoval:0',
    'a=T38FaxTranscodingMMR:0',
    'a=T38FaxTranscodingJBIG:0',
    'a=T38FaxRateManagement:transferredTCF',
    'a=T38FaxMaxBuffer:200',
    'a=T38FaxMaxDatagram:512',
    'a=T38FaxUdpEC:t38UDPRedundancy',
    '',
  ].join('\r\n');
}

/**
 * Execute a genuine real-time ITU-T T.38 FoIP call over local UDP sockets (SIP/SDP + UDPTL + T.30 + T.4).
 * Emits telemetry events via onEvent({ type, ... }).
 */
export async function executeT38Transmission({
  fromNumber,
  toNumber,
  pages,
  fine = true,
  stormyLine = false,
  targetStatus = 'online', // 'online' | 'offline' | 'busy'
  pacingMs = 18,
  onEvent = () => {},
}) {
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

  // Bind 4 real OS UDP sockets: Sender SIP, Receiver SIP, Sender UDPTL, Receiver UDPTL
  const sSip = await bindLocalUdp();
  const rSip = await bindLocalUdp();
  const sUdp = await bindLocalUdp();
  const rUdp = await bindLocalUdp();

  const sendSipUdp = (fromSock, dstPort, buf, fromSender) =>
    new Promise((resolve) => {
      const srcPort = fromSock.address().port;
      pcap.addUdpPacket({ srcPort, dstPort, payload: buf, fromSender });
      fromSock.send(buf, dstPort, '127.0.0.1', () => resolve());
    });

  let senderSeq = 0;
  let receiverSeq = 0;
  const senderHistory = [];
  const receiverHistory = [];
  let totalUdptlBytes = 0;

  const sendUdptl = (fromSender, ifpObj, summaryLabel = '') =>
    new Promise((resolve) => {
      const ifpBuf = encodeIFP(ifpObj);
      const history = fromSender ? senderHistory : receiverHistory;
      const redundancy = history.slice(-1); // 1-packet UDPTL error recovery redundancy
      const seq = fromSender ? senderSeq++ : receiverSeq++;
      const pkt = encodeUDPTL(seq, ifpBuf, redundancy);
      history.push(ifpBuf);
      if (history.length > 4) history.shift();

      totalUdptlBytes += pkt.length;
      const sock = fromSender ? sUdp.sock : rUdp.sock;
      const srcPort = fromSender ? sUdp.port : rUdp.port;
      const dstPort = fromSender ? rUdp.port : sUdp.port;

      pcap.addUdpPacket({ srcPort, dstPort, payload: pkt, fromSender });
      sock.send(pkt, dstPort, '127.0.0.1', () => {
        emitLog('UDPTL', fromSender ? 'TX→RX' : 'RX→TX', summaryLabel || `seq=${seq} (${pkt.length}B)`, {
          seq,
          bytes: pkt.length,
        });
        resolve({ seq, pkt });
      });
    });

  // Setup real UDP listeners on Receiver & Sender UDPTL sockets
  const rxReceivedPackets = [];
  const txReceivedPackets = [];
  rUdp.sock.on('message', (msg) => {
    try {
      rxReceivedPackets.push(decodeUDPTL(msg));
    } catch {
      // ignore malformed
    }
  });
  sUdp.sock.on('message', (msg) => {
    try {
      txReceivedPackets.push(decodeUDPTL(msg));
    } catch {
      // ignore malformed
    }
  });

  // Also capture SIP socket messages
  const waitSipOn = (sock) =>
    new Promise((resolve) => {
      sock.once('message', (msg) => resolve(msg.toString('utf8')));
    });

  try {
    // 1. SIP INVITE with T.38 SDP
    onEvent({ type: 'phase', phase: 'DIALING', detail: `Dialing ${toNumber}...` });
    const sdpOffer = buildT38Sdp({ sessionId: startedAt, udptlPort: sUdp.port });
    const inviteMsg = buildSipMessage(
      `INVITE sip:${toNumber.replace(/\s+/g, '')}@retrofax.local SIP/2.0`,
      {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Contact: `<sip:sender@127.0.0.1:${sSip.port}>`,
        'Content-Type': 'application/sdp',
      },
      sdpOffer
    );

    const rxSipPromise = waitSipOn(rSip.sock);
    await sendSipUdp(sSip.sock, rSip.port, inviteMsg, true);
    await rxSipPromise;
    emitLog('SIP', 'TX→RX', `INVITE sip:${toNumber} (SDP m=image ${sUdp.port} udptl t38)`);

    // Handle Busy
    if (targetStatus === 'busy') {
      await sleep(500);
      const busyMsg = buildSipMessage('SIP/2.0 486 Busy Here', {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
      });
      const txSipPromise = waitSipOn(sSip.sock);
      await sendSipUdp(rSip.sock, sSip.port, busyMsg, false);
      await txSipPromise;
      emitLog('SIP', 'RX→TX', '486 Busy Here (Line in use)');
      onEvent({ type: 'phase', phase: 'BUSY', detail: 'Line Busy (486)' });
      return {
        status: 'busy',
        pcapBuffer: pcap.toBuffer(),
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

    // Send 180 Ringing
    const ringingMsg = buildSipMessage('SIP/2.0 180 Ringing', {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '1 INVITE',
    });
    const ringPromise = waitSipOn(sSip.sock);
    await sendSipUdp(rSip.sock, sSip.port, ringingMsg, false);
    await ringPromise;
    emitLog('SIP', 'RX→TX', '180 Ringing');
    onEvent({ type: 'phase', phase: 'RINGING', detail: `Ringing ${toNumber}...` });

    // Handle Ring No Answer (offline)
    if (targetStatus === 'offline') {
      for (let r = 1; r <= 3; r++) {
        onEvent({ type: 'ring_pulse', ring: r });
        await sleep(850);
      }
      const noAnsMsg = buildSipMessage('SIP/2.0 480 Temporarily Unavailable', {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Reason: 'Q.850;cause=19;text="No Answer from User"',
      });
      const txNoAnsPromise = waitSipOn(sSip.sock);
      await sendSipUdp(rSip.sock, sSip.port, noAnsMsg, false);
      await txNoAnsPromise;
      emitLog('SIP', 'RX→TX', '480 Temporarily Unavailable (Ring No Answer)');
      onEvent({ type: 'phase', phase: 'NO_ANSWER', detail: 'No Answer (480)' });
      return {
        status: 'no_answer',
        pcapBuffer: pcap.toBuffer(),
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

    // Online: short ring, then 200 OK with Receiver SDP
    await sleep(650);
    const sdpAnswer = buildT38Sdp({ sessionId: startedAt + 1, udptlPort: rUdp.port });
    const okMsg = buildSipMessage(
      'SIP/2.0 200 OK',
      {
        Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}`,
        From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
        To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
        'Call-ID': callId,
        CSeq: '1 INVITE',
        Contact: `<sip:receiver@127.0.0.1:${rSip.port}>`,
        'Content-Type': 'application/sdp',
      },
      sdpAnswer
    );
    const okWait = waitSipOn(sSip.sock);
    await sendSipUdp(rSip.sock, sSip.port, okMsg, false);
    await okWait;
    emitLog('SIP', 'RX→TX', `200 OK (SDP m=image ${rUdp.port} udptl t38)`);

    const ackMsg = buildSipMessage(`ACK sip:receiver@127.0.0.1:${rSip.port} SIP/2.0`, {
      Via: `SIP/2.0/UDP 127.0.0.1:${sSip.port};branch=${branch}-ack`,
      From: `<sip:${fromNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${fromTag}`,
      To: `<sip:${toNumber.replace(/\s+/g, '')}@retrofax.local>;tag=${toTag}`,
      'Call-ID': callId,
      CSeq: '1 ACK',
    });
    const ackWait = waitSipOn(rSip.sock);
    await sendSipUdp(sSip.sock, rSip.port, ackMsg, true);
    await ackWait;
    emitLog('SIP', 'TX→RX', 'ACK (T.38 UDPTL channel established)');

    // 2. Phase B: T.30 over UDPTL
    onEvent({ type: 'phase', phase: 'HANDSHAKE', detail: 'T.30 V.21 / V.17 Negotiating...' });

    await sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.CNG }, 'T30-ind: cng (1100Hz calling tone)');
    await sleep(160);
    await sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.CED }, 'T30-ind: ced (2100Hz answer tone)');
    await sleep(140);
    await sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');

    const csi = buildCSIFrame(toNumber);
    const dis = buildDISFrame({ fine });
    await sendUdptl(
      false,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: csi },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK, data: Buffer.alloc(0) },
        ],
      },
      `T.30 CSI: "${toNumber}"`
    );
    await sendUdptl(
      false,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: dis },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
        ],
      },
      `T.30 DIS: ${parseHDLCFrame(dis).detail}`
    );
    await sleep(180);

    await sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');
    const tsi = buildTSIFrame(fromNumber);
    const dcs = buildDCSFrame({ fine, bitRate: 14400 });
    await sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: tsi },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK, data: Buffer.alloc(0) },
        ],
      },
      `T.30 TSI: "${fromNumber}"`
    );
    await sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: dcs },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
        ],
      },
      `T.30 DCS: V.17 14400bps ${fine ? 'FINE' : 'STD'}`
    );
    await sleep(160);

    // TCF Training Check Field (V.17 14400 bps long training + 1.5s zero check burst)
    await sendUdptl(
      true,
      { kind: 'indicator', indicator: T30_INDICATOR.V17_14400_LONG_TRAINING },
      'T30-ind: v17-14400-long-training'
    );
    const tcfZeros = Buffer.alloc(512, 0x00);
    await sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V17_14400,
        fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_DATA, data: tcfZeros }],
      },
      'T.30 TCF Training Check Field (512B)'
    );
    await sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V17_14400,
        fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_SIG_END, data: Buffer.alloc(0) }],
      },
      'T.30 TCF End'
    );
    await sleep(180);

    // CFR Confirmation to Receive
    await sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');
    const cfr = buildHDLCFrame(T30_FCF.CFR);
    await sendUdptl(
      false,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: cfr },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
        ],
      },
      'T.30 CFR (Confirmation to Receive — 14400 bps OK)'
    );
    await sleep(140);

    // 3. Phase C: Send each page as real T.4 MH compressed scanlines over UDP UDPTL
    const rxPacketStartIdx = rxReceivedPackets.length;
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

      await sendUdptl(
        true,
        { kind: 'indicator', indicator: T30_INDICATOR.V17_14400_LONG_TRAINING },
        `T30-ind: v17-14400-long-training (Page ${pageIdx + 1})`
      );

      // Encode 1-bit pixels -> genuine T.4 MH bitstream
      const t4Stream = encodeT4MH(page.pixels, page.width || FAX_WIDTH, page.height, { lsbFirst: true });

      // Optional comedic "90s Phone Line Static" glitch on wire (avoid leading/trailing EOLs)
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
      const chunkDelay = pacingMs > 0 ? Math.min(pacingMs, Math.max(2, Math.floor(1500 / Math.max(1, totalChunks)))) : 0;
      const progressStep = Math.max(1, Math.floor(totalChunks / 20));
      const pageStartRxIdx = rxReceivedPackets.length;

      for (let c = 0; c < totalChunks; c++) {
        const chunk = wireStream.subarray(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);
        totalT4Bytes += chunk.length;
        const pct = Math.round(((c + 1) / totalChunks) * 100);
        const logEvery = c === 0 || c === totalChunks - 1 || c % Math.max(8, progressStep * 2) === 0;

        await sendUdptl(
          true,
          {
            kind: 'data',
            dataType: T30_DATA.V17_14400,
            fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_DATA, data: chunk }],
          },
          logEvery
            ? `T.4 MH Page ${pageIdx + 1} chunk ${c + 1}/${totalChunks} (${chunk.length}B, ${pct}%)`
            : ''
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

      // End of page carrier
      await sendUdptl(
        true,
        {
          kind: 'data',
          dataType: T30_DATA.V17_14400,
          fields: [{ fieldType: FIELD_TYPE.T4_NON_ECM_SIG_END, data: Buffer.alloc(0) }],
        },
        `T.4 Page ${pageIdx + 1} t4-non-ecm-sig-end`
      );

      // Give localhost UDP receiver a moment to flush all incoming packets
      await sleep(30);

      // Reassemble T.4 bitstream *purely from the packets received on Receiver's UDP socket!*
      const rxT4Chunks = [];
      for (let i = pageStartRxIdx; i < rxReceivedPackets.length; i++) {
        const p = rxReceivedPackets[i];
        if (p.primary?.kind === 'data' && p.primary.dataType === T30_DATA.V17_14400) {
          for (const f of p.primary.fields) {
            if (f.fieldType === FIELD_TYPE.T4_NON_ECM_DATA && f.data) {
              rxT4Chunks.push(f.data);
            }
          }
        }
      }
      const assembledT4 = Buffer.concat(rxT4Chunks);
      const decoded = decodeT4MH(assembledT4, page.width || FAX_WIDTH, { lsbFirst: true });
      receivedPages.push(decoded);

      // Post-message signal: MPS (more pages) or EOP (last page)
      await sendUdptl(true, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');
      const isLast = pageIdx === pages.length - 1;
      const postMsg = buildHDLCFrame(isLast ? T30_FCF.EOP : T30_FCF.MPS);
      await sendUdptl(
        true,
        {
          kind: 'data',
          dataType: T30_DATA.V21,
          fields: [
            { fieldType: FIELD_TYPE.HDLC_DATA, data: postMsg },
            { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
          ],
        },
        isLast ? 'T.30 EOP (End of Procedure)' : `T.30 MPS (Multi-Page Signal, more pages follow)`
      );
      await sleep(80);

      // Receiver sends MCF (Message Confirmation)
      await sendUdptl(false, { kind: 'indicator', indicator: T30_INDICATOR.V21_PREAMBLE }, 'T30-ind: v21-preamble');
      const mcf = buildHDLCFrame(T30_FCF.MCF);
      await sendUdptl(
        false,
        {
          kind: 'data',
          dataType: T30_DATA.V21,
          fields: [
            { fieldType: FIELD_TYPE.HDLC_DATA, data: mcf },
            { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
          ],
        },
        `T.30 MCF (Page ${pageIdx + 1} Confirmed — ${decoded.height} scanlines decoded)`
      );
      await sleep(80);
    }

    // 4. Phase E: DCN + SIP BYE
    const dcn = buildHDLCFrame(T30_FCF.DCN);
    await sendUdptl(
      true,
      {
        kind: 'data',
        dataType: T30_DATA.V21,
        fields: [
          { fieldType: FIELD_TYPE.HDLC_DATA, data: dcn },
          { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END, data: Buffer.alloc(0) },
        ],
      },
      'T.30 DCN (Disconnect)'
    );

    const byeMsg = buildSipMessage(`BYE sip:receiver@127.0.0.1:${rSip.port} SIP/2.0`, {
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
    emitLog('SIP', 'RX→TX', '200 OK (Session Closed)');

    const durationMs = Date.now() - startedAt;
    onEvent({ type: 'phase', phase: 'COMPLETED', detail: 'Fax Sent (MCF Confirmed)' });

    return {
      status: 'ok',
      receivedPages,
      pcapBuffer: pcap.toBuffer(),
      logs,
      report: {
        status: 'OK (MCF Confirmed)',
        protocol: 'ITU-T T.38 UDPTL / SIP SDP',
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
        rxPacketsDecoded: rxReceivedPackets.length - rxPacketStartIdx,
        scanlineErrors: receivedPages.reduce((acc, p) => acc + p.errors, 0),
        durationMs,
        stormyLine,
        senderPort: sUdp.port,
        receiverPort: rUdp.port,
      },
    };
  } finally {
    sSip.sock.close();
    rSip.sock.close();
    sUdp.sock.close();
    rUdp.sock.close();
  }
}
