/**
 * Synthesised sound effects and ambient pad using WebAudio.
 * Everything is generated procedurally — no audio assets needed.
 */

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.sfxEnabled = true;
    this.ambientEnabled = false;
    this.ambientNodes = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Sharp "clack" of a stone on wood: noise burst + tuned thump. */
  stoneClick() {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    // Click transient: short filtered noise.
    const noiseLen = 0.06;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.5);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2300 + Math.random() * 600;
    bp.Q.value = 1.4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, t);
    noise.connect(bp).connect(noiseGain).connect(ctx.destination);
    noise.start(t);

    // Wooden body resonance.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190 + Math.random() * 40, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Soft airy swish for captured stones leaving the board. */
  captureSwish(count = 1) {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 0.45;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.sin((i / data.length) * Math.PI);
      data[i] = (Math.random() * 2 - 1) * env * 0.6;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + dur * 0.7);
    const gain = ctx.createGain();
    gain.gain.value = Math.min(0.16 + count * 0.03, 0.3);
    noise.connect(lp).connect(gain).connect(ctx.destination);
    noise.start(t);
  }

  /** Gentle pad: two slowly-beating sines through a lowpass filter. */
  startAmbient() {
    const ctx = this.ensureContext();
    if (!ctx || this.ambientNodes) return;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 3);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.connect(master).connect(ctx.destination);

    const oscs = [110, 110.6, 165.2].map((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(lp);
      osc.start();
      return osc;
    });

    // Slow swell so the pad breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(master.gain);
    lfo.start();

    this.ambientNodes = { master, oscs, lfo };
  }

  stopAmbient() {
    if (!this.ambientNodes || !this.ctx) return;
    const { master, oscs, lfo } = this.ambientNodes;
    const t = this.ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 1);
    setTimeout(() => {
      oscs.forEach((o) => o.stop());
      lfo.stop();
      master.disconnect();
    }, 1200);
    this.ambientNodes = null;
  }

  setSfx(enabled) {
    this.sfxEnabled = enabled;
  }

  setAmbient(enabled) {
    this.ambientEnabled = enabled;
    if (enabled) this.startAmbient();
    else this.stopAmbient();
  }
}
