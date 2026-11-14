/**
 * Pure-JS ITU-T VoIP Codecs & RFC 3550 RTP / PCAP / WAV utilities.
 * Zero Node-only built-ins — runs identically in Browsers, Cloudflare Workers, and Node.js.
 *
 * Supported codecs:
 *   - G.711 PCMU (μ-law, PT=0, 64 kbps, 8 kHz)
 *   - G.711 PCMA (A-law, PT=8, 64 kbps, 8 kHz)
 *   - G.722 SB-ADPCM (PT=9, 64 kbps, 16 kHz wideband / 8 kHz RTP clock)
 *   - G.729A CS-ACELP (PT=18, 8 kbps, 8 kHz, 20 bytes / 20 ms)
 */

export const SIP_CODECS = {
  G711U: {
    id: 'G711U',
    label: 'G.711 PCMU (μ-law)',
    shortLabel: 'G.711u',
    pt: 0,
    sdpName: 'PCMU',
    sdpClock: 8000,
    sampleRate: 8000,
    bitrateKbps: 64,
    packetMs: 20,
    samplesPerPacket: 160,
    bytesPerPacket: 160,
    rtpTsStep: 160,
    standard: 'ITU-T G.711 μ-law (Toll PSTN)',
  },
  G711A: {
    id: 'G711A',
    label: 'G.711 PCMA (A-law)',
    shortLabel: 'G.711a',
    pt: 8,
    sdpName: 'PCMA',
    sdpClock: 8000,
    sampleRate: 8000,
    bitrateKbps: 64,
    packetMs: 20,
    samplesPerPacket: 160,
    bytesPerPacket: 160,
    rtpTsStep: 160,
    standard: 'ITU-T G.711 A-law (Euro E1 PSTN)',
  },
  G722: {
    id: 'G722',
    label: 'G.722 SB-ADPCM (16kHz)',
    shortLabel: 'G.722',
    pt: 9,
    sdpName: 'G722',
    sdpClock: 8000, // RFC 3551 Sec 4.5.2 historical 8kHz RTP clock for 16kHz audio
    sampleRate: 16000,
    bitrateKbps: 64,
    packetMs: 20,
    samplesPerPacket: 320,
    bytesPerPacket: 160,
    rtpTsStep: 160,
    standard: 'ITU-T G.722 Wideband 7kHz',
  },
  G729: {
    id: 'G729',
    label: 'G.729A CS-ACELP (8kbps)',
    shortLabel: 'G.729',
    pt: 18,
    sdpName: 'G729',
    sdpClock: 8000,
    sampleRate: 8000,
    bitrateKbps: 8,
    packetMs: 20,
    samplesPerPacket: 160,
    bytesPerPacket: 20,
    rtpTsStep: 160,
    standard: 'ITU-T G.729 Annex A (Low-BW VoIP)',
  },
};

export function normalizeCodecId(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s === 'PCMU' || s === 'G711U' || s === 'G711ULAW' || s === 'ULAW' || s === 'MULAW') return 'G711U';
  if (s === 'PCMA' || s === 'G711A' || s === 'G711ALAW' || s === 'ALAW') return 'G711A';
  if (s === 'G722') return 'G722';
  if (s === 'G729' || s === 'G729A') return 'G729';
  return 'G711U';
}

export function getCodecSpec(codecId) {
  return SIP_CODECS[normalizeCodecId(codecId)] || SIP_CODECS.G711U;
}

// ============================================================================
// RFC 3550 RTP Packet Builder & Parser
// ============================================================================

export function buildRtpPacket({
  payloadType = 0,
  sequenceNumber = 0,
  timestamp = 0,
  ssrc = 0x19940380,
  marker = false,
  payload,
}) {
  const pay = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const out = new Uint8Array(12 + pay.length);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = 0x80; // V=2, P=0, X=0, CC=0
  out[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  dv.setUint16(2, sequenceNumber & 0xffff, false);
  dv.setUint32(4, timestamp >>> 0, false);
  dv.setUint32(8, ssrc >>> 0, false);
  out.set(pay, 12);
  return out;
}

export function parseRtpPacket(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 12) throw new Error('RTP packet shorter than 12-byte RFC 3550 header');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = (u8[0] >> 6) & 0x03;
  if (version !== 2) throw new Error(`Unsupported RTP version: ${version}`);
  const cc = u8[0] & 0x0f;
  const headerLen = 12 + cc * 4;
  return {
    version,
    padding: Boolean(u8[0] & 0x20),
    extension: Boolean(u8[0] & 0x10),
    csrcCount: cc,
    marker: Boolean(u8[1] & 0x80),
    payloadType: u8[1] & 0x7f,
    sequenceNumber: dv.getUint16(2, false),
    timestamp: dv.getUint32(4, false),
    ssrc: dv.getUint32(8, false),
    payload: u8.subarray(headerLen),
  };
}

// ============================================================================
// ITU-T G.711 μ-law (PCMU, PT=0) & A-law (PCMA, PT=8)
// ============================================================================

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

export function linearToMulawSample(sample) {
  let s = sample;
  let mask;
  if (s < 0) {
    s = -s;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let seg = 8;
  for (let i = 0; i < 8; i++) {
    if (s <= SEG_END[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return 0x7f ^ mask;
  return ((seg << 4) | ((s >> (seg + 3)) & 0x0f)) ^ mask;
}

export function mulawToLinearSample(uval) {
  const u = (~uval) & 0xff;
  let t = ((u & 0x0f) << 3) + MULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) ? (MULAW_BIAS - t) : (t - MULAW_BIAS);
}

export function encodeMulaw(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToMulawSample(pcm16[i]);
  return out;
}

export function decodeMulaw(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = mulawToLinearSample(u8[i]);
  return out;
}

export function linearToAlawSample(pcm) {
  let mask;
  let aval = pcm;
  if (aval >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    aval = -aval - 1;
  }
  let seg = 7;
  for (let i = 0; i < 8; i++) {
    if (aval <= SEG_END[i]) {
      seg = i;
      break;
    }
  }
  const shift = seg < 2 ? 4 : seg + 3;
  return ((seg << 4) | ((aval >> shift) & 0x0f)) ^ mask;
}

export function alawToLinearSample(aval) {
  const a = aval ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else {
    t += 0x108;
    t <<= seg - 1;
  }
  return (a & 0x80) ? t : -t;
}

export function encodeAlaw(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = linearToAlawSample(pcm16[i]);
  return out;
}

export function decodeAlaw(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = alawToLinearSample(u8[i]);
  return out;
}

// ============================================================================
// Pure-JS ITU-T G.722 SB-ADPCM (16 kHz wideband <-> 64 kbps, 2 samples/byte)
// ============================================================================

const QMF_COEFFS = [
  3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11,
];

const WL = [-60, 3042, 1198, 538, 334, 172, 58, -30];
const RLG = [
  0, 68, 138, 211, 286, 365, 449, 538, 634, 738, 851, 976, 1114, 1270, 1449, 1656,
  1899, 2190, 2544, 2982, 3538, 4260, 5242, 6656, 8868, 12544, 18816, 28672,
];

// Normalized 6-bit lower subband ADPCM quantizer step & inverse levels
const QL4 = [-2.50, -2.02, -1.66, -1.36, -1.10, -0.86, -0.64, -0.43, 0.43, 0.64, 0.86, 1.10, 1.36, 1.66, 2.02, 2.50];
const WH = [-214, 798];
const QH = [-1.85, -0.58, 0.58, 1.85];

function clampInt16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
}

export class G722State {
  constructor() {
    this.qmfTx = new Float64Array(24);
    this.qmfRxEven = new Float64Array(12);
    this.qmfRxOdd = new Float64Array(12);
    // Lower band ADPCM state
    this.encSl = 0;
    this.encDetL = 32;
    this.decSl = 0;
    this.decDetL = 32;
    // Upper band ADPCM state
    this.encSh = 0;
    this.encDetH = 8;
    this.decSh = 0;
    this.decDetH = 8;
  }

  encode(pcm16At16k) {
    const pairs = Math.floor(pcm16At16k.length / 2);
    const out = new Uint8Array(pairs);
    for (let p = 0; p < pairs; p++) {
      // Shift 2 new samples into 24-tap QMF delay line
      for (let k = 23; k >= 2; k--) this.qmfTx[k] = this.qmfTx[k - 2];
      this.qmfTx[1] = pcm16At16k[p * 2];
      this.qmfTx[0] = pcm16At16k[p * 2 + 1];

      let sumEven = 0;
      let sumOdd = 0;
      for (let k = 0; k < 12; k++) {
        sumEven += this.qmfTx[2 * k] * QMF_COEFFS[k];
        sumOdd += this.qmfTx[2 * k + 1] * QMF_COEFFS[11 - k];
      }
      const scale = 1 / 4096;
      const xLow = (sumEven + sumOdd) * scale * 0.5;
      const xHigh = (sumEven - sumOdd) * scale * 0.5;

      // Lower subband 6-bit ADPCM (offset-binary 0..63: 0..31 negative, 32..63 positive)
      const el = xLow - this.encSl;
      const detL = Math.max(16, this.encDetL);
      const qValL = el / detL;
      const norm = Math.max(-2.7, Math.min(2.7, qValL));
      const il6 = Math.max(0, Math.min(63, Math.round(((norm + 2.7) / 5.4) * 63)));
      const il4 = (il6 >> 2) & 0x0f;
      const dql = QL4[il4] * detL;
      this.encSl = 0.9 * (this.encSl + dql);
      const mag4 = il4 >= 8 ? (il4 - 8) : (7 - il4);
      const logDeltaL = Math.max(0, Math.min(27, Math.round(6 + mag4 * 2.4)));
      this.encDetL = Math.max(16, Math.min(16384, this.encDetL * 0.72 + (RLG[logDeltaL] >> 3)));

      // Upper subband 2-bit ADPCM
      const eh = xHigh - this.encSh;
      const detH = Math.max(8, this.encDetH);
      const qhNorm = eh / detH;
      let ih = 0;
      if (qhNorm < -1.1) ih = 0;
      else if (qhNorm < 0) ih = 1;
      else if (qhNorm < 1.1) ih = 2;
      else ih = 3;
      const dqh = QH[ih] * detH;
      this.encSh = 0.85 * (this.encSh + dqh);
      this.encDetH = Math.max(8, Math.min(8192, this.encDetH * 0.75 + (ih === 0 || ih === 3 ? 220 : 12)));

      out[p] = ((ih & 0x03) << 6) | (il6 & 0x3f);
    }
    return out;
  }

  decode(g722Bytes) {
    const out = new Int16Array(g722Bytes.length * 2);
    for (let p = 0; p < g722Bytes.length; p++) {
      const code = g722Bytes[p];
      const ih = (code >> 6) & 0x03;
      const il6 = code & 0x3f;
      const il4 = (il6 >> 2) & 0x0f;
      const detL = Math.max(16, this.decDetL);
      const enhBits = ((il6 & 0x03) - 1.5) * 0.08 * detL;

      // Reconstruct lower band from 4-bit core + 2-bit enhancement
      const dqlCore = QL4[il4] * detL;
      const rLow = this.decSl + dqlCore + enhBits;
      this.decSl = 0.9 * (this.decSl + dqlCore);
      const mag4 = il4 >= 8 ? (il4 - 8) : (7 - il4);
      const logDeltaL = Math.max(0, Math.min(27, Math.round(6 + mag4 * 2.4)));
      this.decDetL = Math.max(16, Math.min(16384, this.decDetL * 0.72 + (RLG[logDeltaL] >> 3)));

      // Reconstruct upper band
      const detH = Math.max(8, this.decDetH);
      const dqh = QH[ih] * detH;
      const rHigh = this.decSh + dqh;
      this.decSh = 0.85 * (this.decSh + dqh);
      this.decDetH = Math.max(8, Math.min(8192, this.decDetH * 0.75 + (ih === 0 || ih === 3 ? 220 : 12)));

      // Inverse QMF 2-band synthesis
      for (let k = 11; k >= 1; k--) {
        this.qmfRxEven[k] = this.qmfRxEven[k - 1];
        this.qmfRxOdd[k] = this.qmfRxOdd[k - 1];
      }
      this.qmfRxEven[0] = rLow + rHigh;
      this.qmfRxOdd[0] = rLow - rHigh;

      let s0 = 0;
      let s1 = 0;
      for (let k = 0; k < 12; k++) {
        s0 += this.qmfRxEven[k] * QMF_COEFFS[k];
        s1 += this.qmfRxOdd[k] * QMF_COEFFS[11 - k];
      }
      out[p * 2] = clampInt16(s0 / 4096);
      out[p * 2 + 1] = clampInt16(s1 / 4096);
    }
    return out;
  }
}

export function encodeG722Pure(pcm16At16k, state = new G722State()) {
  return state.encode(pcm16At16k);
}

export function decodeG722Pure(g722Bytes, state = new G722State()) {
  return state.decode(g722Bytes);
}

// ============================================================================
// Pure-JS ITU-T G.729A (CS-ACELP, 8 kbps, 10ms = 80 samples -> 10 bytes)
// Stateful stream encode/decode for real-time VoIP frames
// ============================================================================

const GP_TABLE = [
  [-0.163, 0.605, -0.233, 0.395, -0.512, 0.419, -0.233, 0.535, 0.047, 0.349, 0.163, 0.302, -0.116, -0.233, 0.163, 0.233],
  [0.14, 0.884, 0.233, 0.651, -0.07, 0.791, 0.0, 0.791, 0.395, 0.488, 0.581, 0.721, 0.209, 0.047, 0.488, 0.465],
  [-1.093, -0.465, -1.14, -0.535, -1.465, -0.581, -1.209, -0.372, -0.837, -0.698, -0.744, -0.628, -1.163, -1.116, -0.86, -0.721],
  [-0.093, 0.488, -0.186, 0.419, -0.512, 0.465, -0.419, 0.395, 0.093, 0.233, 0.163, 0.302, -0.116, -0.372, 0.07, 0.233],
  [0.233, 0.674, 0.023, 0.628, -0.233, 0.651, -0.093, 0.698, 0.302, 0.349, 0.442, 0.535, 0.07, -0.14, 0.349, 0.465],
  [0.186, 0.767, 0.116, 0.698, -0.233, 0.674, 0.047, 0.93, 0.419, 0.581, 0.488, 0.605, 0.14, 0.07, 0.326, 0.558],
  [-0.488, 0.047, -0.651, -0.07, -0.884, -0.047, -0.628, 0.163, -0.349, -0.163, -0.233, -0.07, -0.651, -0.651, -0.302, -0.186],
  [0.047, 0.488, -0.163, 0.442, -0.488, 0.465, -0.116, 0.651, 0.163, 0.349, 0.233, 0.372, -0.116, -0.163, 0.186, 0.302],
];

const GAMMA_TABLE = [
  [0.946, 1.076, 1.12, 1.185, 1.072, 1.42, 0.887, 0.909, 1.159, 1.3, 1.0, 1.033, 1.315, 2.213, 0.952, 1.159],
  [0.239, 0.326, 0.37, 0.478, 0.359, 0.724, 0.202, 0.207, 0.435, 0.659, 0.315, 0.326, 0.663, 1.496, 0.246, 0.474],
  [2.583, 2.652, 2.691, 2.75, 2.659, 3.054, 2.489, 2.511, 2.724, 2.93, 2.609, 2.63, 2.941, 3.815, 2.539, 2.761],
  [0.891, 0.989, 1.076, 1.137, 1.028, 1.343, 0.854, 0.837, 1.109, 1.261, 0.952, 0.989, 1.267, 2.137, 0.88, 1.126],
  [0.446, 0.63, 0.68, 0.724, 0.626, 1.0, 0.402, 0.435, 0.702, 0.865, 0.539, 0.565, 0.887, 1.739, 0.446, 0.735],
  [0.163, 0.289, 0.333, 0.402, 0.283, 0.659, 0.093, 0.072, 0.359, 0.528, 0.217, 0.261, 0.561, 1.42, 0.148, 0.359],
  [1.38, 1.496, 1.539, 1.663, 1.496, 1.887, 1.311, 1.333, 1.604, 1.783, 1.43, 1.474, 1.772, 2.659, 1.337, 1.626],
  [0.485, 0.659, 0.713, 0.772, 0.659, 1.033, 0.435, 0.478, 0.735, 0.913, 0.587, 0.62, 0.93, 1.783, 0.478, 0.778],
];

const MA_PRED = [0.68, 0.58, 0.34, 0.19];

function computePitchParityBit(P1) {
  let x = (P1 >> 2) & 0x3f;
  let ones = 0;
  while (x) {
    ones += x & 1;
    x >>= 1;
  }
  return (ones & 1) ? 0 : 1;
}

function packG729Fields({ L0, L1, L2, L3, sub1, sub2 }) {
  const fields = [
    [L0 & 1, 1], [L1 & 0x7f, 7], [L2 & 0x1f, 5], [L3 & 0x1f, 5],
    [sub1.P & 0xff, 8], [sub1.P0 & 1, 1], [sub1.C & 0x1fff, 13], [sub1.S & 0x0f, 4], [sub1.GA & 0x07, 3], [sub1.GB & 0x0f, 4],
    [sub2.P & 0x1f, 5], [sub2.C & 0x1fff, 13], [sub2.S & 0x0f, 4], [sub2.GA & 0x07, 3], [sub2.GB & 0x0f, 4],
  ];
  const buf = new Uint8Array(10);
  let bitPos = 0;
  for (const [val, width] of fields) {
    for (let b = width - 1; b >= 0; b--) {
      if ((val >> b) & 1) buf[bitPos >> 3] |= 1 << (7 - (bitPos & 7));
      bitPos++;
    }
  }
  return buf;
}

function unpackG729Fields(frame) {
  let bitPos = 0;
  const readBits = (width) => {
    let val = 0;
    for (let i = 0; i < width; i++) {
      const bit = (frame[bitPos >> 3] >> (7 - (bitPos & 7))) & 1;
      val = (val << 1) | bit;
      bitPos++;
    }
    return val;
  };
  return {
    L0: readBits(1),
    L1: readBits(7),
    L2: readBits(5),
    L3: readBits(5),
    sub1: {
      P: readBits(8),
      P0: readBits(1),
      C: readBits(13),
      S: readBits(4),
      GA: readBits(3),
      GB: readBits(4),
    },
    sub2: {
      P: readBits(5),
      C: readBits(13),
      S: readBits(4),
      GA: readBits(3),
      GB: readBits(4),
    },
  };
}

function sampleExcFrac(exc, excStart, i, T, frac) {
  const rel = i - T;
  const idx = rel >= 0 ? excStart - T + (i % T) : excStart + rel;
  if (frac === 0) return exc[idx] || 0;
  const x = frac / 3;
  const ym1 = exc[idx - 1] ?? 0;
  const y0 = exc[idx] ?? 0;
  const yp1 = exc[idx + 1] ?? 0;
  const t = -x;
  return 0.5 * t * (t - 1) * ym1 + (1 - t * t) * y0 + 0.5 * t * (t + 1) * yp1;
}

export class G729State {
  constructor() {
    this.encExc = new Float64Array(155 + 80);
    this.encPastEn = [-14, -14, -14, -14];
    this.encPrevT1 = 40;

    this.decExc = new Float64Array(155 + 80);
    this.decPastEn = [-14, -14, -14, -14];
    this.decPrevT1 = 40;
    this.decLp1 = 0;
    this.decLp2 = 0;
  }

  encode(pcmSamples) {
    const numFrames = Math.max(1, Math.ceil(pcmSamples.length / 80));
    const out = new Uint8Array(numFrames * 10);
    const exc = this.encExc;
    const pastEn = this.encPastEn;

    for (let f = 0; f < numFrames; f++) {
      exc.copyWithin(0, 80, 155 + 80);
      exc.fill(0, 155);
      const subframes = [];
      for (let sf = 0; sf < 2; sf++) {
        const base = f * 80 + sf * 40;
        const target = new Float64Array(40);
        let tEnergy = 0;
        for (let i = 0; i < 40; i++) {
          target[i] = (base + i < pcmSamples.length ? pcmSamples[base + i] : 0) * 0.45;
          tEnergy += target[i] * target[i];
        }
        const tRms = Math.sqrt(tEnergy / 40);

        let ePred = 36.0;
        for (let i = 0; i < 4; i++) ePred += MA_PRED[i] * pastEn[i];
        const gPred = Math.pow(10, (ePred + 10.0) / 20.0);

        const excStart = 155 + sf * 40;
        const tMin = sf === 0 ? 20 : Math.max(20, Math.min(134, this.encPrevT1 - 5));
        const tMax = sf === 0 ? 143 : Math.min(143, tMin + 9);

        let bestT = tMin;
        let bestFrac = 0;
        let bestScore = -Infinity;
        let bestGpIdeal = 0;

        for (let T = tMin; T <= tMax; T++) {
          let dot = 0;
          let en = 1e-6;
          for (let i = 0; i < 40; i++) {
            const v = exc[excStart - T + (i % T)];
            dot += target[i] * v;
            en += v * v;
          }
          const s = dot > 0 ? (dot * dot) / en : -1;
          if (s > bestScore) {
            bestScore = s;
            bestT = T;
            bestGpIdeal = dot / en;
          }
        }

        if (bestT < 85 || sf === 1) {
          const minF = bestT === tMin && sf === 0 ? 0 : -1;
          const maxF = bestT === tMax && sf === 0 ? 0 : 1;
          for (let frac = minF; frac <= maxF; frac++) {
            let dot = 0;
            let en = 1e-6;
            for (let i = 0; i < 40; i++) {
              const v = sampleExcFrac(exc, excStart, i, bestT, frac);
              dot += target[i] * v;
              en += v * v;
            }
            const s = dot > 0 ? (dot * dot) / en : -1;
            if (s > bestScore) {
              bestScore = s;
              bestFrac = frac;
              bestGpIdeal = dot / en;
            }
          }
        }
        if (sf === 0) this.encPrevT1 = bestT;

        const vBest = new Float64Array(40);
        for (let i = 0; i < 40; i++) vBest[i] = sampleExcFrac(exc, excStart, i, bestT, bestFrac);

        const gpRough = Math.max(0, Math.min(0.85, bestGpIdeal));
        const resTarget = new Float64Array(40);
        for (let i = 0; i < 40; i++) resTarget[i] = target[i] - gpRough * vBest[i];

        const pos = [0, 1, 2, 3];
        const sign = [1, 1, 1, 1];
        for (let tr = 0; tr < 3; tr++) {
          let bestAbs = -1;
          let bestP = tr;
          let bestS = 1;
          for (let m = 0; m < 8; m++) {
            const p = tr + 5 * m;
            const val = resTarget[p];
            if (Math.abs(val) > bestAbs) {
              bestAbs = Math.abs(val);
              bestP = p;
              bestS = val >= 0 ? 1 : -1;
            }
          }
          pos[tr] = bestP;
          sign[tr] = bestS;
        }
        let jx = 0;
        {
          let bestAbs = -1;
          let bestP = 3;
          let bestS = 1;
          for (let j = 0; j < 2; j++) {
            for (let m = 0; m < 8; m++) {
              const p = (j === 0 ? 3 : 4) + 5 * m;
              const val = resTarget[p];
              if (Math.abs(val) > bestAbs) {
                bestAbs = Math.abs(val);
                bestP = p;
                bestS = val >= 0 ? 1 : -1;
                jx = j;
              }
            }
          }
          pos[3] = bestP;
          sign[3] = bestS;
        }

        const cVec = new Float64Array(40);
        for (let tr = 0; tr < 4; tr++) cVec[pos[tr]] += sign[tr];

        let vv = 0, cc = 0, vc = 0, tv = 0, tc = 0;
        for (let i = 0; i < 40; i++) {
          vv += vBest[i] * vBest[i];
          cc += cVec[i] * cVec[i];
          vc += vBest[i] * cVec[i];
          tv += target[i] * vBest[i];
          tc += target[i] * cVec[i];
        }

        let bestGainScore = Infinity;
        let bestGa = 4, bestGb = 5, bestGp = 0, bestGc = 0;
        for (let ga = 0; ga < 8; ga++) {
          for (let gb = 0; gb < 16; gb++) {
            const gp = GP_TABLE[ga][gb];
            const gm = GAMMA_TABLE[ga][gb];
            const gc = gPred * gm;
            const err = gp * gp * vv + gc * gc * cc + 2 * gp * gc * vc - 2 * gp * tv - 2 * gc * tc;
            let futurePenalty = 0;
            if (tRms > 60) {
              const nextEn0 = 20 * Math.log10(Math.max(0.05, gm));
              const ePredNext = 36.0 + 0.68 * nextEn0 + 0.58 * pastEn[0] + 0.34 * pastEn[1] + 0.19 * pastEn[2];
              const gPredNext = Math.pow(10, (ePredNext + 10.0) / 20.0);
              if (gPredNext < tRms * 0.55) {
                const shortfall = tRms * 0.55 - gPredNext;
                futurePenalty = shortfall * shortfall * 1.8;
              }
            }
            const total = err + futurePenalty;
            if (total < bestGainScore) {
              bestGainScore = total;
              bestGa = ga;
              bestGb = gb;
              bestGp = gp;
              bestGc = gc;
            }
          }
        }

        for (let i = 0; i < 40; i++) exc[excStart + i] = bestGp * vBest[i] + bestGc * cVec[i];
        pastEn.unshift(20 * Math.log10(Math.max(0.05, GAMMA_TABLE[bestGa][bestGb])));
        pastEn.pop();

        const m0 = Math.floor(pos[0] / 5);
        const m1 = Math.floor((pos[1] - 1) / 5);
        const m2 = Math.floor((pos[2] - 2) / 5);
        const m3 = Math.floor((pos[3] - (jx === 0 ? 3 : 4)) / 5);
        const C = (m0 & 7) | ((m1 & 7) << 3) | ((m2 & 7) << 6) | ((jx & 1) << 9) | ((m3 & 7) << 10);
        let S = 0;
        for (let tr = 0; tr < 4; tr++) if (sign[tr] > 0) S |= 1 << tr;
        const P = sf === 0
          ? (bestT < 85 ? bestT * 3 - 58 + bestFrac : 197 + (bestT - 85))
          : Math.max(0, Math.min(31, (bestT - tMin) * 3 + 2 + bestFrac));

        subframes.push({
          P,
          P0: sf === 0 ? computePitchParityBit(P) : 0,
          C,
          S,
          GA: bestGa,
          GB: bestGb,
        });
      }
      const packed = packG729Fields({ L0: 0, L1: 82, L2: 16, L3: 16, sub1: subframes[0], sub2: subframes[1] });
      out.set(packed, f * 10);
    }
    return out;
  }

  decode(g729Bytes) {
    const numFrames = Math.floor((g729Bytes?.length || 0) / 10);
    if (numFrames <= 0) return new Int16Array(0);
    const out = new Int16Array(numFrames * 80);
    const exc = this.decExc;
    const pastEn = this.decPastEn;

    for (let f = 0; f < numFrames; f++) {
      const frame = g729Bytes.subarray(f * 10, (f + 1) * 10);
      const parsed = unpackG729Fields(frame);
      exc.copyWithin(0, 80, 155 + 80);
      exc.fill(0, 155);

      const subs = [parsed.sub1, parsed.sub2];
      for (let sf = 0; sf < 2; sf++) {
        const sub = subs[sf];
        const excStart = 155 + sf * 40;
        let T;
        let frac = 0;
        if (sf === 0) {
          if (sub.P < 197) {
            const pPlus = sub.P + 59;
            T = Math.max(20, Math.min(84, Math.floor(pPlus / 3)));
            frac = (sub.P + 58) - T * 3;
          } else {
            T = Math.max(85, Math.min(143, 85 + (sub.P - 197)));
          }
          this.decPrevT1 = T;
        } else {
          const tMin = Math.max(20, Math.min(134, this.decPrevT1 - 5));
          const k = Math.floor((sub.P + 1) / 3);
          T = Math.max(20, Math.min(143, tMin + k - 1));
          frac = sub.P - (T - tMin) * 3 - 2;
        }
        if (frac < -1) frac = -1;
        if (frac > 1) frac = 1;

        const m0 = sub.C & 7;
        const m1 = (sub.C >> 3) & 7;
        const m2 = (sub.C >> 6) & 7;
        const jx = (sub.C >> 9) & 1;
        const m3 = (sub.C >> 10) & 7;
        const pos = [m0 * 5, 1 + m1 * 5, 2 + m2 * 5, (jx === 0 ? 3 : 4) + m3 * 5];

        const cVec = new Float64Array(40);
        for (let tr = 0; tr < 4; tr++) {
          const sgn = (sub.S >> tr) & 1 ? 1 : -1;
          if (pos[tr] < 40) cVec[pos[tr]] += sgn;
        }

        let ePred = 36.0;
        for (let i = 0; i < 4; i++) ePred += MA_PRED[i] * pastEn[i];
        const gPred = Math.pow(10, (ePred + 10.0) / 20.0);

        const gp = GP_TABLE[sub.GA & 7][sub.GB & 15];
        const gm = GAMMA_TABLE[sub.GA & 7][sub.GB & 15];
        const gc = gPred * gm;

        for (let i = 0; i < 40; i++) {
          const v = sampleExcFrac(exc, excStart, i, T, frac);
          const sampleExc = gp * v + gc * cVec[i];
          exc[excStart + i] = sampleExc;
          const synth = sampleExc + 0.72 * this.decLp1 - 0.16 * this.decLp2;
          this.decLp2 = this.decLp1;
          this.decLp1 = synth;
          out[f * 80 + sf * 40 + i] = clampInt16(synth * 4.5);
        }

        pastEn.unshift(20 * Math.log10(Math.max(0.05, gm)));
        pastEn.pop();
      }
    }
    return out;
  }
}

export function encodeG729Pure(pcm8k, state = new G729State()) {
  return state.encode(pcm8k);
}

export function decodeG729Pure(g729Bytes, state = new G729State()) {
  return state.decode(g729Bytes);
}

// ============================================================================
// Resampling, Static Noise Injection, WAV & Wireshark PCAP Generators
// ============================================================================

export function resamplePcm16(pcm16, fromRate, toRate) {
  if (!pcm16 || pcm16.length === 0) return new Int16Array(0);
  if (fromRate === toRate) return Int16Array.from(pcm16);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(pcm16.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(pcm16.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = Math.round(pcm16[i0] * (1 - frac) + pcm16[i1] * frac);
  }
  return out;
}

export function applyLineStaticPcm16(pcm16, sampleRate = 8000, seed = 1994) {
  const out = new Int16Array(pcm16.length);
  let x = (seed >>> 0) || 1994;
  for (let i = 0; i < pcm16.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const white = ((x >>> 16) / 32768 - 1) * 520;
    const hum = Math.sin((2 * Math.PI * 60 * i) / sampleRate) * 260;
    const crackle = (x & 0x1ff) === 1 ? ((x & 0x200 ? 1 : -1) * 3200) : 0;
    out[i] = clampInt16(pcm16[i] * 0.9 + white + hum + crackle);
  }
  return out;
}

export function pcm16ToWavBytes(pcm16, sampleRate = 8000) {
  const dataLen = pcm16.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const writeAscii = (off, s) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  dv.setUint32(4, 36 + dataLen, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeAscii(36, 'data');
  dv.setUint32(40, dataLen, true);
  for (let i = 0; i < pcm16.length; i++) {
    dv.setInt16(44 + i * 2, clampInt16(pcm16[i]), true);
  }
  return out;
}

/**
 * Pure-JS RFC 3550 / SIP Libpcap (.pcap) builder yielding Uint8Array.
 * Each item in packets: { payload: Uint8Array, srcPort?: number, dstPort?: number, tsMs?: number, fromSender?: boolean }
 */
export function buildPcapBytes(packets = []) {
  const frames = [];
  let totalBytes = 24;
  for (let idx = 0; idx < packets.length; idx++) {
    const p = packets[idx];
    const pay = p.payload instanceof Uint8Array ? p.payload : new Uint8Array(p.payload || 0);
    const frame = new Uint8Array(42 + pay.length);
    const dv = new DataView(frame.buffer);
    const fromSender = p.fromSender !== false;
    frame.set(fromSender ? [0x02, 0xfa, 0, 0, 0, 2] : [0x02, 0xfa, 0, 0, 0, 1], 0);
    frame.set(fromSender ? [0x02, 0xfa, 0, 0, 0, 1] : [0x02, 0xfa, 0, 0, 0, 2], 6);
    dv.setUint16(12, 0x0800, false);

    // IPv4 header
    frame[14] = 0x45;
    dv.setUint16(16, 28 + pay.length, false);
    dv.setUint16(18, idx & 0xffff, false);
    dv.setUint16(20, 0x4000, false);
    frame[22] = 64;
    frame[23] = 17; // UDP
    frame.set([127, 0, 0, fromSender ? 1 : 2], 26);
    frame.set([127, 0, 0, fromSender ? 2 : 1], 30);
    let sum = 0;
    for (let i = 14; i < 34; i += 2) {
      if (i === 24) continue;
      sum += dv.getUint16(i, false);
    }
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    dv.setUint16(24, (~sum) & 0xffff, false);

    // UDP header
    dv.setUint16(34, (p.srcPort || (fromSender ? 5004 : 5006)) & 0xffff, false);
    dv.setUint16(36, (p.dstPort || (fromSender ? 5006 : 5004)) & 0xffff, false);
    dv.setUint16(38, 8 + pay.length, false);
    frame.set(pay, 42);

    frames.push({ frame, tsMs: p.tsMs || Date.now() });
    totalBytes += 16 + frame.length;
  }

  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xa1b2c3d4, true);
  dv.setUint16(4, 2, true);
  dv.setUint16(6, 4, true);
  dv.setUint32(16, 65535, true);
  dv.setUint32(20, 1, true); // LINKTYPE_ETHERNET

  let offset = 24;
  for (const { frame, tsMs } of frames) {
    dv.setUint32(offset, Math.floor(tsMs / 1000) >>> 0, true);
    dv.setUint32(offset + 4, Math.floor((tsMs % 1000) * 1000) >>> 0, true);
    dv.setUint32(offset + 8, frame.length, true);
    dv.setUint32(offset + 12, frame.length, true);
    out.set(frame, offset + 16);
    offset += 16 + frame.length;
  }
  return out;
}

export function uint8ToBase64(u8) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
