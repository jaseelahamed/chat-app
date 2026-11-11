// Synthesizes subtle notification chimes and call ringtones via Web Audio API.

class SoundFX {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.ringInterval = null;
  }

  ensureContext() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freq, duration = 0.14, type = 'sine', volume = 0.08, delay = 0) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playMessageChime() {
    if (!this.enabled) return;
    this.playTone(660, 0.1, 'sine', 0.05, 0);
    this.playTone(880, 0.14, 'sine', 0.05, 0.08);
  }

  startRingtone(isOutgoing = false) {
    this.stopRingtone();
    if (!this.enabled) return;

    const playPattern = () => {
      if (!this.enabled) return;
      if (isOutgoing) {
        this.playTone(440, 0.35, 'sine', 0.04, 0);
        this.playTone(480, 0.35, 'sine', 0.04, 0);
      } else {
        this.playTone(587.33, 0.18, 'triangle', 0.08, 0);
        this.playTone(783.99, 0.22, 'triangle', 0.08, 0.2);
        this.playTone(987.77, 0.26, 'triangle', 0.07, 0.42);
      }
    };

    playPattern();
    this.ringInterval = setInterval(playPattern, isOutgoing ? 2800 : 2200);
  }

  stopRingtone() {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
  }
}

export const soundFX = new SoundFX();

