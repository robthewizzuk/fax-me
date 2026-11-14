import { spawn } from 'node:child_process';
import { encodeG729, decodeG729 } from './g729Codec.js';

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
    standard: 'ITU-T G.711 A-law (Euro E1 PSTN)',
  },
  G722: {
    id: 'G722',
    label: 'G.722 SB-ADPCM (16kHz)',
    shortLabel: 'G.722',
    pt: 9,
    sdpName: 'G722',
    sdpClock: 8000, // RFC 3551 Sec 4.5.2 historical 8kHz RTP clock for 16kHz audio!
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
    bytesPerPacket: 20, // Two 10ms (10B) frames per 20ms RTP packet
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

// ---------- ITU-T G.711 μ-law (PCMU, PT=0) ----------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

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
    if (s <= MULAW_SEG_END[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return 0x7f ^ mask;
  const uval = (seg << 4) | ((s >> (seg + 3)) & 0x0f);
  return uval ^ mask;
}

export function mulawToLinearSample(uval) {
  const u = (~uval) & 0xff;
  let t = ((u & 0x0f) << 3) + MULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) ? (MULAW_BIAS - t) : (t - MULAW_BIAS);
}

export function encodeMulaw(pcm16) {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = linearToMulawSample(pcm16[i]);
  }
  return out;
}

export function decodeMulaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = mulawToLinearSample(buf[i]);
  }
  return out;
}

// ---------- ITU-T G.711 A-law (PCMA, PT=8) ----------

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
  const alawSegEnd = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];
  for (let i = 0; i < 8; i++) {
    if (aval <= alawSegEnd[i]) {
      seg = i;
      break;
    }
  }
  const shift = seg < 2 ? 4 : seg + 3;
  const low = (aval >> shift) & 0x0f;
  return ((seg << 4) | low) ^ mask;
}

export function alawToLinearSample(aval) {
  let a = aval ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
      break;
  }
  return (a & 0x80) ? t : -t;
}

export function encodeAlaw(pcm16) {
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = linearToAlawSample(pcm16[i]);
  }
  return out;
}

export function decodeAlaw(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = alawToLinearSample(buf[i]);
  }
  return out;
}

// ---------- ITU-T G.722 SB-ADPCM (PT=9, 16kHz PCM -> 64kbps) via FFmpeg ----------

function runFfmpegPipe(args, inputBuf) {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const chunks = [];
    const errs = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errs.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errs).toString('utf8')}`));
      }
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(inputBuf);
  });
}

function int16ToBufferLE(pcm16) {
  const buf = Buffer.allocUnsafe(pcm16.length * 2);
  for (let i = 0; i < pcm16.length; i++) {
    buf.writeInt16LE(pcm16[i], i * 2);
  }
  return buf;
}

function bufferLEToInt16(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

export async function encodeG722(pcm16At16k) {
  if (!pcm16At16k?.length) return Buffer.alloc(0);
  const rawIn = int16ToBufferLE(pcm16At16k);
  return runFfmpegPipe(
    ['-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'g722', '-f', 'g722', 'pipe:1'],
    rawIn
  );
}

export async function decodeG722(g722Buf) {
  if (!g722Buf?.length) return new Int16Array(0);
  const rawOut = await runFfmpegPipe(
    ['-f', 'g722', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
    g722Buf
  );
  return bufferLEToInt16(rawOut);
}

// ---------- PCM Resampling, Parsing & WAV Export ----------

export function resamplePcm16(pcm16, fromRate, toRate) {
  if (!pcm16 || pcm16.length === 0) return new Int16Array(0);
  if (fromRate === toRate) return Int16Array.from(pcm16);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(pcm16.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(pcm16.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = Math.round(pcm16[i0] * (1 - frac) + pcm16[i1] * frac);
  }
  return out;
}

export function pcm16ToWav(pcm16, sampleRate = 8000) {
  const dataLen = pcm16.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // PCM linear
  buf.writeUInt16LE(1, 22);  // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buf.writeUInt16LE(2, 32);  // BlockAlign
  buf.writeUInt16LE(16, 34); // BitsPerSample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm16.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm16[i]))), 44 + i * 2);
  }
  return buf;
}

export async function decodeUploadedAudioToPcm16(audioBuf, targetRate = 8000) {
  if (!audioBuf || audioBuf.length < 16) {
    throw new Error('Uploaded audio buffer is empty');
  }
  // Fast path for standard uncompressed RIFF PCM16 WAV
  if (audioBuf.toString('ascii', 0, 4) === 'RIFF' && audioBuf.toString('ascii', 8, 12) === 'WAVE') {
    let pos = 12;
    let audioFormat = 1;
    let channels = 1;
    let sampleRate = targetRate;
    let bitsPerSample = 16;
    let dataChunk = null;
    while (pos + 8 <= audioBuf.length) {
      const id = audioBuf.toString('ascii', pos, pos + 4);
      const size = audioBuf.readUInt32LE(pos + 4);
      const bodyStart = pos + 8;
      if (id === 'fmt ' && bodyStart + 16 <= audioBuf.length) {
        audioFormat = audioBuf.readUInt16LE(bodyStart);
        channels = audioBuf.readUInt16LE(bodyStart + 2);
        sampleRate = audioBuf.readUInt32LE(bodyStart + 4);
        bitsPerSample = audioBuf.readUInt16LE(bodyStart + 14);
      } else if (id === 'data') {
        dataChunk = audioBuf.subarray(bodyStart, Math.min(audioBuf.length, bodyStart + size));
        break;
      }
      pos = bodyStart + size + (size & 1);
    }
    if (audioFormat === 1 && bitsPerSample === 16 && dataChunk) {
      const totalFrames = Math.floor(dataChunk.length / (2 * channels));
      const mono = new Int16Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += dataChunk.readInt16LE((i * channels + ch) * 2);
        }
        mono[i] = Math.round(sum / channels);
      }
      return resamplePcm16(mono, sampleRate, targetRate);
    }
  }

  // Fallback for compressed formats / browser MediaRecorder (WebM/Opus, OGG, MP3, etc.)
  const raw = await runFfmpegPipe(
    ['-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(targetRate), 'pipe:1'],
    audioBuf
  );
  return bufferLEToInt16(raw);
}

// ---------- Unified Codec Dispatch ----------

export async function encodeAudioForCodec(pcm16, inputSampleRate, codecId) {
  const spec = getCodecSpec(codecId);
  const resampled = resamplePcm16(pcm16, inputSampleRate, spec.sampleRate);

  if (spec.id === 'G711U') {
    return {
      spec,
      encoded: encodeMulaw(resampled),
      inputPcm: resampled,
    };
  }
  if (spec.id === 'G711A') {
    return {
      spec,
      encoded: encodeAlaw(resampled),
      inputPcm: resampled,
    };
  }
  if (spec.id === 'G722') {
    return {
      spec,
      encoded: await encodeG722(resampled),
      inputPcm: resampled,
    };
  }
  // G.729A
  const { bitstream } = encodeG729(resampled);
  return {
    spec,
    encoded: bitstream,
    inputPcm: resampled,
  };
}

export async function decodeAudioForCodec(encodedBuf, codecId) {
  const spec = getCodecSpec(codecId);
  if (!encodedBuf || encodedBuf.length === 0) {
    return { spec, pcm16: new Int16Array(0), sampleRate: spec.sampleRate };
  }
  let pcm16;
  if (spec.id === 'G711U') {
    pcm16 = decodeMulaw(encodedBuf);
  } else if (spec.id === 'G711A') {
    pcm16 = decodeAlaw(encodedBuf);
  } else if (spec.id === 'G722') {
    pcm16 = await decodeG722(encodedBuf);
  } else {
    pcm16 = await decodeG729(encodedBuf);
  }
  return { spec, pcm16, sampleRate: spec.sampleRate };
}
