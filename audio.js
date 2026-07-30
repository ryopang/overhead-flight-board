// audio.js — per-flip "clack" playback via Web Audio API.
//
// Plays back a short (110ms) sample (clack.wav), trimmed from a single isolated
// hit in a reference recording the user provided directly and confirmed is
// clear to use. Played through Web Audio (not a plain <audio> tag) so multiple
// overlapping hits — the per-character stagger across a row — layer cleanly,
// with small per-hit pitch/gain jitter so a cascade doesn't sound like the same
// sample looped identically.
//
// Falls back to the previous synthesized knock (Karplus-Strong physical
// modeling — see git history) if the sample fails to load, so the board never
// goes silent just because one fetch failed.

class ClackPlayer {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.buffer = null;
    this.bufferPromise = null;
  }

  /** Must be called from a user gesture (Safari autoplay policy). */
  unlock() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.bufferPromise = this._loadBuffer();
  }

  async _loadBuffer() {
    try {
      const res = await fetch('/clack.wav');
      if (!res.ok) throw new Error(`clack.wav ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      this.buffer = null; // clack() falls back to synthesis below
    }
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

  /** Karplus-Strong knock — fallback only, used when clack.wav isn't available. */
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

  _synthesizedClack(ctx, t, jitter) {
    const knockFreqHi = 1150 + Math.random() * 200;
    const knockFreqLo = 820 + Math.random() * 130;
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
    this._karplusKnock(ctx, t, knockFreqHi, 0.5 * jitter(), 0.3 + Math.random() * 0.1, 0.035);
    this._karplusKnock(ctx, t, knockFreqLo, 0.32 * jitter(), 0.3 + Math.random() * 0.1, 0.035);
    {
      const delay = 0.022 + Math.random() * 0.006;
      this._karplusKnock(ctx, t + delay, knockFreqHi * 1.05, 0.16 * jitter(), 0.26, 0.02);
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

    if (!this.buffer) {
      this._synthesizedClack(ctx, t, jitter);
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    // Slight per-hit pitch/gain variation so a staggered cascade across a row
    // doesn't sound like the exact same sample looped identically.
    src.playbackRate.value = 0.94 + Math.random() * 0.12;
    const g = ctx.createGain();
    g.gain.value = 0.8 * jitter();
    src.connect(g).connect(ctx.destination);
    src.start(t);
  }
}

window.ClackPlayer = ClackPlayer;
