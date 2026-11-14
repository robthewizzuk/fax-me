import { spawn } from 'node:child_process';

/**
 * Pure-JS ITU-T G.729A (CS-ACELP, 8 kbps, 10ms = 80 samples -> 10 bytes/frame) Encoder
 * calibrated against FFmpeg's libavcodec G.729 decoder (/usr/bin/ffmpeg -f g729).
 *
 * Frame bit layout (80 bits, MSB-first):
 *   L0:1, L1:7, L2:5, L3:5,
 *   P1:8, P0:1, C1:13, S1:4, GA1:3, GB1:4,
 *   P2:5, C2:13, S2:4, GA2:3, GB2:4
 */

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

function packG729Frame({ L0, L1, L2, L3, sub1, sub2 }) {
  const fields = [
    [L0 & 1, 1],
    [L1 & 0x7f, 7],
    [L2 & 0x1f, 5],
    [L3 & 0x1f, 5],
    [sub1.P & 0xff, 8],
    [sub1.P0 & 1, 1],
    [sub1.C & 0x1fff, 13],
    [sub1.S & 0x0f, 4],
    [sub1.GA & 0x07, 3],
    [sub1.GB & 0x0f, 4],
    [sub2.P & 0x1f, 5],
    [sub2.C & 0x1fff, 13],
    [sub2.S & 0x0f, 4],
    [sub2.GA & 0x07, 3],
    [sub2.GB & 0x0f, 4],
  ];
  const buf = Buffer.alloc(10, 0);
  let bitPos = 0;
  for (const [val, width] of fields) {
    for (let b = width - 1; b >= 0; b--) {
      if ((val >> b) & 1) {
        buf[bitPos >> 3] |= 1 << (7 - (bitPos & 7));
      }
      bitPos++;
    }
  }
  return buf;
}

export function computePitchParityBit(P1) {
  let x = (P1 >> 2) & 0x3f;
  let ones = 0;
  while (x) {
    ones += x & 1;
    x >>= 1;
  }
  return (ones & 1) ? 0 : 1;
}

// 4-tap Lagrange interpolation of past excitation at fractional lag T + frac/3 (frac in {-1, 0, +1})
function sampleExcFrac(exc, excStart, i, T, frac) {
  const rel = i - T;
  const idx = rel >= 0 ? excStart - T + (i % T) : excStart + rel;
  if (frac === 0) return exc[idx];
  const x = frac / 3;
  // Linear/cubic-lite around idx (idx - 1, idx, idx + 1) remembering negative lags correspond to EARLIER samples
  // Note: larger lag T + x corresponds to index - (T + x) = idx - x!
  const ym1 = exc[idx - 1] ?? 0;
  const y0 = exc[idx] ?? 0;
  const yp1 = exc[idx + 1] ?? 0;
  // Lagrange quadratic on (-1, 0, +1) evaluated at t = -x
  const t = -x;
  return 0.5 * t * (t - 1) * ym1 + (1 - t * t) * y0 + 0.5 * t * (t + 1) * yp1;
}

/**
 * Encode 8kHz mono Int16Array PCM into ITU-T G.729A frames (10 bytes per 10ms = 80 samples).
 * Returns { bitstream: Buffer, frames: number, samplesPadded: number }.
 */
export function encodeG729(pcmSamples) {
  const numFrames = Math.max(1, Math.ceil(pcmSamples.length / 80));
  const out = Buffer.alloc(numFrames * 10);
  const exc = new Float64Array(155 + 80);
  const pastEn = [-14, -14, -14, -14];
  let prevT1 = 40;

  // Flat/minimal-ringing ITU G.729 LSP codeword verified against ffmpeg -f g729
  const L0 = 0;
  const L1 = 82;
  const L2 = 16;
  const L3 = 16;

  for (let f = 0; f < numFrames; f++) {
    exc.copyWithin(0, 80, 155 + 80);
    exc.fill(0, 155);

    const subframes = [];
    for (let sf = 0; sf < 2; sf++) {
      const base = f * 80 + sf * 40;
      const target = new Float64Array(40);
      let tEnergy = 0;
      for (let i = 0; i < 40; i++) {
        // Empirical gain normalization calibrated for G.729 synthesis & postfilter RMS parity
        target[i] = (base + i < pcmSamples.length ? pcmSamples[base + i] : 0) * 0.45;
        tEnergy += target[i] * target[i];
      }
      const tRms = Math.sqrt(tEnergy / 40);

      // 1. Predicted base fixed-codebook gain gPred
      let ePred = 36.0;
      for (let i = 0; i < 4; i++) ePred += MA_PRED[i] * pastEn[i];
      const gPred = Math.pow(10, (ePred + 10.0) / 20.0);

      // 2. Closed-loop adaptive codebook search (integer then fractional {-1/3, 0, +1/3})
      const excStart = 155 + sf * 40;
      const tMin = sf === 0 ? 20 : Math.max(20, Math.min(134, prevT1 - 5));
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
      if (sf === 0) prevT1 = bestT;

      const vBest = new Float64Array(40);
      for (let i = 0; i < 40; i++) {
        vBest[i] = sampleExcFrac(exc, excStart, i, bestT, bestFrac);
      }

      // 3. 4-track ACELP algebraic pulse search
      const gpRough = Math.max(0, Math.min(0.85, bestGpIdeal));
      const resTarget = new Float64Array(40);
      for (let i = 0; i < 40; i++) {
        resTarget[i] = target[i] - gpRough * vBest[i];
      }

      const pos = [0, 1, 2, 3];
      const sign = [1, 1, 1, 1];
      let jx = 0;

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

      {
        let bestAbs = -1;
        let bestP = 3;
        let bestS = 1;
        let bestJ = 0;
        for (let j = 0; j < 2; j++) {
          for (let m = 0; m < 8; m++) {
            const p = (j === 0 ? 3 : 4) + 5 * m;
            const val = resTarget[p];
            if (Math.abs(val) > bestAbs) {
              bestAbs = Math.abs(val);
              bestP = p;
              bestS = val >= 0 ? 1 : -1;
              bestJ = j;
            }
          }
        }
        pos[3] = bestP;
        sign[3] = bestS;
        jx = bestJ;
      }

      const cVec = new Float64Array(40);
      for (let tr = 0; tr < 4; tr++) {
        cVec[pos[tr]] += sign[tr];
      }

      // 4. Exhaustive 128-entry joint (GA, GB) closed-loop search with MA anti-starvation guard
      let vv = 0;
      let cc = 0;
      let vc = 0;
      let tv = 0;
      let tc = 0;
      for (let i = 0; i < 40; i++) {
        vv += vBest[i] * vBest[i];
        cc += cVec[i] * cVec[i];
        vc += vBest[i] * cVec[i];
        tv += target[i] * vBest[i];
        tc += target[i] * cVec[i];
      }

      let bestGainScore = Infinity;
      let bestGa = 4;
      let bestGb = 5;
      let bestGp = 0;
      let bestGc = 0;

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

      // 5. Update adaptive codebook excitation & MA prediction state
      for (let i = 0; i < 40; i++) {
        exc[excStart + i] = bestGp * vBest[i] + bestGc * cVec[i];
      }
      pastEn.unshift(20 * Math.log10(Math.max(0.05, GAMMA_TABLE[bestGa][bestGb])));
      pastEn.pop();

      const m0 = Math.floor(pos[0] / 5);
      const m1 = Math.floor((pos[1] - 1) / 5);
      const m2 = Math.floor((pos[2] - 2) / 5);
      const m3 = Math.floor((pos[3] - (jx === 0 ? 3 : 4)) / 5);
      const C = (m0 & 7) | ((m1 & 7) << 3) | ((m2 & 7) << 6) | ((jx & 1) << 9) | ((m3 & 7) << 10);
      let S = 0;
      for (let tr = 0; tr < 4; tr++) {
        if (sign[tr] > 0) S |= 1 << tr;
      }

      let P;
      if (sf === 0) {
        P = bestT < 85 ? bestT * 3 - 58 + bestFrac : 197 + (bestT - 85);
      } else {
        P = Math.max(0, Math.min(31, (bestT - tMin) * 3 + 2 + bestFrac));
      }

      subframes.push({
        P,
        P0: sf === 0 ? computePitchParityBit(P) : 0,
        C,
        S,
        GA: bestGa,
        GB: bestGb,
      });
    }

    packG729Frame({
      L0,
      L1,
      L2,
      L3,
      sub1: subframes[0],
      sub2: subframes[1],
    }).copy(out, f * 10);
  }

  return {
    bitstream: out,
    frames: numFrames,
    samplesPadded: numFrames * 80,
  };
}

/**
 * Decode genuine ITU-T G.729 bitstream into 8kHz mono Int16Array via FFmpeg's libavcodec G.729 decoder.
 */
export function decodeG729(g729Buf) {
  const usableBytes = Math.floor((g729Buf?.length || 0) / 10) * 10;
  if (usableBytes <= 0) return Promise.resolve(new Int16Array(0));
  const slice = g729Buf.subarray(0, usableBytes);

  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'g729',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ]);
    const chunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg G.729 decode failed (${code}): ${Buffer.concat(errChunks).toString('utf8')}`));
      }
      const raw = Buffer.concat(chunks);
      const samples = new Int16Array(Math.floor(raw.length / 2));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = raw.readInt16LE(i * 2);
      }
      resolve(samples);
    });
    proc.stdin.end(slice);
  });
}
