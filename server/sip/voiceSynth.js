/**
 * Procedural 1990s Telephony Voice & Formant Synthesizer.
 * Generates 16kHz PCM16 audio (with wideband harmonics up to 7kHz for G.722,
 * cleanly band-limited when downsampled to 8kHz for G.711/G.729) so callers
 * can send spoken/typed voice phrases or converse with 1990s PBX bots even
 * in headless/no-mic environments.
 */

const DTMF_PAIRS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

// Simple 2-formant/3-formant biquad resonator approximation via damped glottal harmonics
const PHONEME_FORMANTS = {
  A: [730, 1090, 2440, 0.9],
  E: [530, 1840, 2480, 0.85],
  I: [270, 2290, 3010, 0.85],
  O: [570, 840, 2410, 0.9],
  U: [300, 870, 2240, 0.8],
  M: [280, 900, 2200, 0.45],
  N: [300, 1400, 2300, 0.45],
  S: [1200, 4200, 6200, 0.35], // wideband sibilance highlights G.722 7kHz band!
  T: [900, 3600, 5600, 0.3],
};

function appendFormantSyllable(buf, offset, lenSamples, sr, f0Start, f0End, formants, amp = 7500, isFricative = false) {
  const [f1, f2, f3, voiceGain] = formants;
  let phase0 = 0;
  let b1 = 0;
  let b2 = 0;
  let z1a = 0, z1b = 0;
  let z2a = 0, z2b = 0;
  let z3a = 0, z3b = 0;

  const mkCoeffs = (freq, bw) => {
    const r = Math.exp((-Math.PI * Math.min(bw, sr * 0.15)) / sr);
    const cos = Math.cos((2 * Math.PI * Math.min(freq, sr * 0.44)) / sr);
    return { a1: 2 * r * cos, a2: -(r * r), gain: (1 - r) * 0.9 };
  };
  const c1 = mkCoeffs(f1, 70);
  const c2 = mkCoeffs(f2, 100);
  const c3 = mkCoeffs(f3, 140);

  for (let i = 0; i < lenSamples && offset + i < buf.length; i++) {
    const t = i / lenSamples;
    const env = Math.sin(Math.PI * Math.min(1, t / 0.15)) * (t > 0.85 ? (1 - t) / 0.15 : 1);
    const f0 = f0Start + (f0End - f0Start) * t;
    phase0 = (phase0 + f0 / sr) % 1;
    // Glottal pulse train + aspiration breath
    const glottal = isFricative
      ? (Math.random() * 2 - 1) * 0.85
      : (phase0 < 0.18 ? Math.sin((phase0 / 0.18) * Math.PI) : -0.18) + (Math.random() * 2 - 1) * 0.04;

    const y1 = c1.gain * glottal + c1.a1 * z1a + c1.a2 * z1b;
    z1b = z1a; z1a = y1;

    const y2 = c2.gain * glottal + c2.a1 * z2a + c2.a2 * z2b;
    z2b = z2a; z2a = y2;

    const y3 = c3.gain * glottal + c3.a1 * z3a + c3.a2 * z3b;
    z3b = z3a; z3a = y3;

    const mixed = (y1 * 0.65 + y2 * 0.35 + y3 * 0.25) * env * voiceGain * amp;
    b1 = buf[offset + i] + mixed;
    b2 = Math.max(-31000, Math.min(31000, b1));
    buf[offset + i] = Math.round(b2);
  }
}

function appendTone(buf, offset, lenSamples, sr, freqs, amp = 5500, decay = 0) {
  for (let i = 0; i < lenSamples && offset + i < buf.length; i++) {
    const t = i / sr;
    const attack = Math.min(1, i / Math.max(1, sr * 0.008));
    const release = Math.min(1, (lenSamples - 1 - i) / Math.max(1, sr * 0.012));
    const d = decay > 0 ? Math.exp(-decay * t) : 1;
    let sum = 0;
    for (let k = 0; k < freqs.length; k++) {
      sum += Math.sin(2 * Math.PI * freqs[k] * t);
    }
    const sample = (sum / Math.max(1, freqs.length)) * amp * attack * release * d;
    buf[offset + i] = Math.max(-31000, Math.min(31000, Math.round(buf[offset + i] + sample)));
  }
}

/**
 * Convert arbitrary short message text into a lively 90s speech/DTMF/tone waveform.
 */
export function synthesizeMessageAudio(text = 'HELLO RETROFAX 1994', sampleRate = 16000) {
  const clean = String(text || 'HELLO 1994').toUpperCase().trim().slice(0, 64) || 'HELLO';
  const tokens = clean.split('');
  const durSec = Math.min(3.2, Math.max(1.2, 0.45 + tokens.length * 0.085));
  const out = new Int16Array(Math.floor(sampleRate * durSec));

  // Signature 90s pre-talk chirp
  appendTone(out, Math.floor(0.03 * sampleRate), Math.floor(0.08 * sampleRate), sampleRate, [880, 1320], 4200, 4);

  let cursor = Math.floor(0.16 * sampleRate);
  let pitch = 135;

  for (let idx = 0; idx < tokens.length && cursor < out.length - Math.floor(0.12 * sampleRate); idx++) {
    const ch = tokens[idx];
    if (DTMF_PAIRS[ch]) {
      const len = Math.floor(0.095 * sampleRate);
      appendTone(out, cursor, len, sampleRate, DTMF_PAIRS[ch], 6000, 0);
      cursor += len + Math.floor(0.03 * sampleRate);
      continue;
    }
    if (ch === ' ' || ch === '-' || ch === '.') {
      cursor += Math.floor(0.055 * sampleRate);
      continue;
    }

    let formKey = 'A';
    let isFric = false;
    if ('AEIOU'.includes(ch)) formKey = ch;
    else if ('SZCFHX'.includes(ch)) { formKey = 'S'; isFric = true; }
    else if ('MN'.includes(ch)) formKey = 'M';
    else if ('TDKPB'.includes(ch)) { formKey = 'T'; isFric = true; }
    else if ('LRWY'.includes(ch)) formKey = 'O';

    const durMs = isFric ? 0.065 : 0.095;
    const len = Math.floor(durMs * sampleRate);
    const nextPitch = 122 + ((idx * 37) % 45);
    appendFormantSyllable(out, cursor, len, sampleRate, pitch, nextPitch, PHONEME_FORMANTS[formKey], isFric ? 5500 : 12000, isFric);
    pitch = nextPitch;
    cursor += Math.floor(len * 0.88);
  }

  // Closing over-and-out roger beep
  appendTone(out, Math.max(cursor, out.length - Math.floor(0.18 * sampleRate)), Math.floor(0.1 * sampleRate), sampleRate, [1046], 4800, 5);
  return out;
}

/**
 * Generate comedic 1990s PBX / Answering Bot reply audio @ sampleRate.
 */
export function generateBotReplyPcm({ botId, callerNumber = '', callerDecodedPcm = null, sampleRate = 16000 }) {
  if (botId === 'bot-echo' && callerDecodedPcm && callerDecodedPcm.length > 0) {
    // Echo Bot: Play cheerful dual-tone confirm, then echo caller's UDP-decoded voice with subtle delay!
    const prefixSamples = Math.floor(0.28 * sampleRate);
    const maxCopy = Math.min(callerDecodedPcm.length, Math.floor(2.6 * sampleRate));
    const tailPad = Math.floor(0.24 * sampleRate);
    const out = new Int16Array(prefixSamples + maxCopy + tailPad);
    appendTone(out, Math.floor(0.02 * sampleRate), Math.floor(0.09 * sampleRate), sampleRate, [660], 5500, 3);
    appendTone(out, Math.floor(0.13 * sampleRate), Math.floor(0.11 * sampleRate), sampleRate, [990], 5800, 3);

    const echoDelay = Math.floor(0.075 * sampleRate);
    for (let i = 0; i < maxCopy; i++) {
      const dry = callerDecodedPcm[i] * 0.9;
      const wet = i >= echoDelay ? callerDecodedPcm[i - echoDelay] * 0.34 : 0;
      out[prefixSamples + i] = Math.max(-31000, Math.min(31000, Math.round(dry + wet)));
    }
    return out;
  }

  if (botId === 'bot-megacorp') {
    // 1994 MegaCorp PBX Hold Jingle + Robotic Receptionist Formants
    const out = new Int16Array(Math.floor(2.4 * sampleRate));
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25];
    notes.forEach((hz, idx) => {
      appendTone(out, Math.floor((0.05 + idx * 0.14) * sampleRate), Math.floor(0.13 * sampleRate), sampleRate, [hz, hz * 2], 4200, 4);
    });
    const speech = synthesizeMessageAudio(`MEGACORP HR HOLD EXT 1994 TPS`, sampleRate);
    const startOff = Math.floor(0.95 * sampleRate);
    for (let i = 0; i < speech.length && startOff + i < out.length; i++) {
      out[startOff + i] = Math.max(-31000, Math.min(31000, out[startOff + i] + speech[i]));
    }
    return out;
  }

  // Mystic Oracle Bot (shimmering harmonic arpeggio + eerie vowel chord + lucky DTMF)
  const out = new Int16Array(Math.floor(2.4 * sampleRate));
  const chimeFreqs = [369.99, 554.37, 659.25, 880.0, 1108.73, 2217.46, 4434.92];
  chimeFreqs.forEach((hz, idx) => {
    appendTone(out, Math.floor((0.04 + idx * 0.11) * sampleRate), Math.floor(0.65 * sampleRate), sampleRate, [hz], 3600, 3.2);
  });
  const chant = synthesizeMessageAudio('THERMAL ORACLE SPEAKS 777', sampleRate);
  const chantOff = Math.floor(0.85 * sampleRate);
  for (let i = 0; i < chant.length && chantOff + i < out.length; i++) {
    out[chantOff + i] = Math.max(-31000, Math.min(31000, out[chantOff + i] + chant[i]));
  }
  return out;
}

/**
 * Inject authentic 1990s noisy PSTN line hum & tape crackle when Line Static is ON.
 */
export function applyLineStatic(pcm16, sampleRate = 8000) {
  const out = Int16Array.from(pcm16);
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const hum = Math.sin(2 * Math.PI * 60 * t) * 420 + Math.sin(2 * Math.PI * 180 * t) * 210;
    const hiss = (Math.random() * 2 - 1) * 580;
    const pop = Math.random() < 0.002 ? (Math.random() * 2 - 1) * 9000 : 0;
    out[i] = Math.max(-32000, Math.min(32000, Math.round(out[i] + hum + hiss + pop)));
  }
  return out;
}
