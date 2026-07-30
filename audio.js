// audio.js — synthesized mechanical "clack" per flip, via Web Audio API. No audio files.
//
// A plain filtered-noise "clack" reads as soft/boomy. Real mechanical clicks (relay
// contacts, hi-hats, a plastic leaf snapping past a stop) have a metallic, pitched
// character from the object's own resonant partials — not just broadband noise.
// This borrows the classic drum-machine hi-hat technique (see Synth Secrets' 808
// hi-hat writeup: a bank of square oscillators tuned to inharmonic ratios, summed,
// then band/highpass filtered with a fast envelope) and layers it with a short
// noise transient for the attack and a brief low thump for mechanical weight.
//
// Pitch is tuned to a low-midrange "clack", not a hi-hat's bright "tick" — a
// mechanical leaf snapping into place is a dull, low-pitched sound, not shrill.

const INHARMONIC_RATIOS = [1, 1.34, 1.62, 2.02, 2.41];

class ClackPlayer {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** Must be called from a user gesture (Safari autoplay policy). */
  unlock() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
  }

  _noiseBuffer(ctx, dur) {
    const size = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** Metallic tick: inharmonic square-oscillator bank -> bandpass -> highpass -> fast AD envelope. */
  _metallicTick(ctx, t, baseFreq, gainPeak, dur) {
    const bus = ctx.createGain();
    bus.gain.value = 1;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseFreq * 1.7;
    bp.Q.value = 0.8;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = Math.max(300, baseFreq * 0.6);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gainPeak, t + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    bus.connect(bp).connect(hp).connect(env).connect(ctx.destination);

    for (const ratio of INHARMONIC_RATIOS) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = baseFreq * ratio;
      const oscGain = ctx.createGain();
      oscGain.gain.value = 1 / INHARMONIC_RATIOS.length;
      osc.connect(oscGain).connect(bus);
      osc.start(t);
      osc.stop(t + dur);
    }
  }

  clack() {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    // iOS/Safari (and other browsers) suspend an idle AudioContext after a while —
    // over a kiosk session running for hours, this WILL happen eventually. Without
    // this check, every clack() after that point silently does nothing forever.
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const jitter = () => 0.9 + Math.random() * 0.2;
    // Low-midrange, not a hi-hat's bright tick — a real leaf snapping into place
    // is a dull, low-pitched clack.
    const baseFreq = 650 + Math.random() * 250;

    // 1) Noise transient — the initial edge of the snap, under the metallic tone.
    {
      const dur = 0.007;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(ctx, dur);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2 * jitter(), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(hp).connect(g).connect(ctx.destination);
      src.start(t);
      src.stop(t + dur);
    }

    // 2) Metallic tick — the main character of the sound.
    this._metallicTick(ctx, t, baseFreq, 0.5 * jitter(), 0.05);

    // 3) Low thump — mechanical weight/mass. A bit more prominent than a hi-hat's
    //    tick would need, since this is meant to read as a "clack" not a "tick".
    {
      const dur = 0.025;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, t);
      osc.frequency.exponentialRampToValueAtTime(65, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16 * jitter(), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    }

    // 4) Settle tick — quieter secondary metallic tick ~25ms later, as the leaf
    //    bounces once against its stop before coming to rest.
    {
      const delay = 0.022 + Math.random() * 0.006;
      this._metallicTick(ctx, t + delay, baseFreq * 1.15, 0.16 * jitter(), 0.022);
    }
  }
}

window.ClackPlayer = ClackPlayer;
