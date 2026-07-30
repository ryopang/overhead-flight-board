// audio.js — synthesized mechanical "clack" per flip, via Web Audio API. No audio files.
//
// First attempt used a bank of tuned square oscillators (the classic 808 hi-hat
// technique) for the resonant body of the sound. That reads as a musical *tone* —
// too clean, too "electronic" — because summed oscillators is fundamentally a
// technique for pitched percussion, not for an object physically hitting a stop.
//
// This version uses Karplus-Strong synthesis instead: a short noise burst excites
// a feedback delay line with a lowpass filter in the loop, which is the standard
// physical-modeling technique for a plucked/struck object's natural resonance
// (originally for guitar strings, but with a short delay + fast decay it's a
// well-known technique for claves, wood blocks, and knocks — an actual object's
// decaying resonance rather than a synthesized tone).
//
// Tuning is based on actually analyzing a reference split-flap recording locally
// (envelope + Goertzel frequency scan — see project notes): the real sound has a
// dominant resonance around 1.1-1.3kHz, a secondary one around 800-900Hz, real
// broadband energy up to 3-3.5kHz, and — contrary to an earlier assumption —
// almost no energy below 200Hz. So: two co-occurring knocks at those two
// resonances, a bright noise transient, and no low-frequency "thump" layer.

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

  /**
   * Karplus-Strong knock: noise burst -> feedback delay loop (with a lowpass
   * filter damping each pass) -> fast decay. Reads as a physical object's brief
   * resonance, not a musical tone. `feedback` close to 0 = a couple of quick
   * decaying bounces (a knock); explicitly disconnected after `dur` since a
   * delay/gain feedback loop otherwise keeps processing (near-silent) forever.
   */
  _karplusKnock(ctx, t, freq, gainPeak, feedback, dur) {
    const delayTime = 1 / freq;
    const exciteDur = delayTime * 1.5;

    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx, exciteDur);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = delayTime;

    const damping = ctx.createBiquadFilter();
    damping.type = 'lowpass';
    damping.frequency.value = freq * 3.5;

    const feedbackGain = ctx.createGain();
    feedbackGain.gain.value = feedback;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gainPeak, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    // Excitation into the loop, loop feeds back through the damping filter,
    // and the damped signal is tapped out through its own envelope.
    src.connect(delay);
    delay.connect(damping);
    damping.connect(feedbackGain);
    feedbackGain.connect(delay);
    damping.connect(env);
    env.connect(ctx.destination);

    src.start(t);

    const cleanupMs = (dur + 0.05) * 1000;
    setTimeout(() => {
      try {
        delay.disconnect();
        damping.disconnect();
        feedbackGain.disconnect();
        env.disconnect();
      } catch {
        // already disconnected — nothing to do
      }
    }, cleanupMs);
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
    // Dominant + secondary resonance, measured from a reference recording.
    const knockFreqHi = 1150 + Math.random() * 200; // ~1.15-1.35kHz, the dominant peak
    const knockFreqLo = 820 + Math.random() * 130; // ~0.8-0.95kHz, the secondary peak

    // 1) Noise transient — bright, broadband attack edge (reference showed real
    //    energy up to 3-3.5kHz, not just a dull thud).
    {
      const dur = 0.006;
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

    // 2) The knock — two co-occurring resonances (dominant + secondary), matching
    //    the dual-peak character measured in the reference. No low-frequency
    //    thump layer: the reference had essentially no energy below ~200Hz.
    this._karplusKnock(ctx, t, knockFreqHi, 0.5 * jitter(), 0.3 + Math.random() * 0.1, 0.035);
    this._karplusKnock(ctx, t, knockFreqLo, 0.32 * jitter(), 0.3 + Math.random() * 0.1, 0.035);

    // 3) Settle knock — quieter secondary hit ~25ms later, as the leaf bounces
    //    once against its stop before coming to rest.
    {
      const delay = 0.022 + Math.random() * 0.006;
      this._karplusKnock(ctx, t + delay, knockFreqHi * 1.05, 0.16 * jitter(), 0.26, 0.02);
    }
  }
}

window.ClackPlayer = ClackPlayer;
