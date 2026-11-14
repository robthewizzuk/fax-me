/**
 * Procedural 1990s Fax Machine Audio Synthesizer (Web Audio API)
 * Zero external audio assets — pure synthesis of DTMF, regional ringback,
 * V.21/V.17 fax handshake screeches, stepper paper feed, and thermal paper rip.
 */

const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

class FaxAudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.activeNodes = [];
  }

  ensureCtx() {
    if (this.muted) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setMuted(m) {
    this.muted = Boolean(m);
    if (this.muted) this.stopAll();
  }

  stopAll() {
    for (const node of this.activeNodes) {
      try { node.stop?.(); } catch {}
      try { node.disconnect?.(); } catch {}
    }
    this.activeNodes = [];
  }

  playButtonClick(pitch = 620) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(pitch, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.035);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.045);
  }

  playDTMF(digit, duration = 0.09) {
    const pair = DTMF_FREQS[String(digit)];
    if (!pair) {
      this.playButtonClick(780);
      return;
    }
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.setValueAtTime(0.08, now + duration - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    gain.connect(ctx.destination);

    pair.forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + duration + 0.01);
    });
  }

  playToneBurst(freqs, startOffset, duration, vol = 0.06, type = 'sine') {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + startOffset;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    gain.gain.setValueAtTime(vol, t0 + Math.max(0.02, duration - 0.02));
    gain.gain.linearRampToValueAtTime(0.001, t0 + duration);
    gain.connect(ctx.destination);

    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t0);
      osc.connect(gain);
      osc.start(t0);
      osc.stop(t0 + duration + 0.01);
      this.activeNodes.push(osc);
    });
  }

  playRingback(toneProfile = 'na') {
    if (toneProfile === 'uk') {
      // Classic British double-ring 400+450Hz
      this.playToneBurst([400, 450], 0, 0.35, 0.055);
      this.playToneBurst([400, 450], 0.52, 0.35, 0.055);
    } else if (toneProfile === 'eu' || toneProfile === 'jp') {
      this.playToneBurst([425], 0, 0.72, 0.055);
    } else {
      // North American 440+480Hz ringback
      this.playToneBurst([440, 480], 0, 0.72, 0.05);
    }
  }

  playIncomingMachineRing() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    // Electronic 90s fax warble ring
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const master = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(980, t0);
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(18, t0);
    lfoGain.gain.setValueAtTime(220, t0);

    lfo.connect(lfoGain).connect(osc.frequency);
    master.gain.setValueAtTime(0.045, t0);
    master.gain.setValueAtTime(0.045, t0 + 0.55);
    master.gain.exponentialRampToValueAtTime(0.001, t0 + 0.65);

    osc.connect(master).connect(ctx.destination);
    lfo.start(t0);
    osc.start(t0);
    lfo.stop(t0 + 0.66);
    osc.stop(t0 + 0.66);
    this.activeNodes.push(osc, lfo);
  }

  playBusySignal() {
    for (let i = 0; i < 4; i++) {
      this.playToneBurst([480, 620], i * 0.5, 0.25, 0.055);
    }
  }

  playBuzzerError() {
    this.playToneBurst([180, 240], 0, 0.16, 0.07, 'sawtooth');
    this.playToneBurst([160, 210], 0.2, 0.22, 0.07, 'sawtooth');
  }

  /**
   * Authentic ITU-T T.30 / V.21 / V.17 modem handshake audio signature
   */
  playFaxHandshake() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    // 1. CNG 1100Hz calling beep
    this.playToneBurst([1100], 0.0, 0.28, 0.06);
    // 2. CED 2100Hz answer tone
    this.playToneBurst([2100], 0.35, 0.45, 0.065);
    // 3. V.21 300-baud FSK chirps (alternating 1650/1850Hz)
    const now = ctx.currentTime;
    const fskOsc = ctx.createOscillator();
    const fskGain = ctx.createGain();
    fskOsc.type = 'sine';
    fskGain.gain.setValueAtTime(0.0001, now);
    fskGain.gain.setValueAtTime(0.055, now + 0.85);
    for (let i = 0; i < 18; i++) {
      const f = (i * 7 + (i % 3)) % 2 === 0 ? 1650 : 1850;
      fskOsc.frequency.setValueAtTime(f, now + 0.85 + i * 0.032);
    }
    fskGain.gain.setValueAtTime(0.0001, now + 1.45);
    fskOsc.connect(fskGain).connect(ctx.destination);
    fskOsc.start(now + 0.85);
    fskOsc.stop(now + 1.48);
    this.activeNodes.push(fskOsc);

    // 4. V.17 14400bps QAM carrier noise burst (bandpass-filtered white noise + 1800Hz carrier)
    const dur = 1.05;
    const bufferSize = Math.floor(ctx.sampleRate * dur);
    const noiseBuf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.7;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1800, now + 1.48);
    filter.Q.setValueAtTime(1.4, now + 1.48);

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.001, now + 1.48);
    nGain.gain.linearRampToValueAtTime(0.075, now + 1.54);
    nGain.gain.setValueAtTime(0.065, now + 2.38);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 2.52);

    noiseSrc.connect(filter).connect(nGain).connect(ctx.destination);
    noiseSrc.start(now + 1.48);
    noiseSrc.stop(now + 2.55);
    this.activeNodes.push(noiseSrc);
  }

  playStepperTick() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(140 + Math.random() * 25, now);
    gain.gain.setValueAtTime(0.018, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  playConfirmBeep() {
    this.playToneBurst([1046], 0, 0.08, 0.06);
    this.playToneBurst([1318], 0.1, 0.14, 0.06);
  }

  playPaperTear() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.24;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.sin((i / len) * Math.PI);
      ch[i] = (Math.random() * 2 - 1) * env * 0.55;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(1800, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.14, now);
    src.connect(hp).connect(gain).connect(ctx.destination);
    src.start(now);
  }

  playStaticBurst() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.11);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * 0.35;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, now);
    src.connect(g).connect(ctx.destination);
    src.start(now);
  }

  playHandsetPickup(toneProfile = 'na') {
    this.playButtonClick(320);
    if (toneProfile === 'uk') {
      this.playToneBurst([350, 440], 0.06, 0.35, 0.035);
    } else if (toneProfile === 'eu' || toneProfile === 'jp') {
      this.playToneBurst([425], 0.06, 0.35, 0.035);
    } else {
      this.playToneBurst([350, 440], 0.06, 0.35, 0.035);
    }
  }

  playHandsetHangup() {
    this.playButtonClick(210);
  }
}

export const faxAudio = new FaxAudioEngine();
