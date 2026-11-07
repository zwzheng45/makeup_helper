/** Gentle, original earcons. These indicate capture and waiting, not recognition success. */
export class MirrorCues {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tones = new Map<OscillatorNode, GainNode>();

  constructor(private context: AudioContext) {}

  private tone(frequency: number, delay: number, duration: number, volume: number): void {
    if (this.context.state !== "running") return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const start = this.context.currentTime + delay;
    const envelope = Float32Array.from({ length: 64 }, (_, i) => volume * Math.sin(Math.PI * i / 63) ** 2);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueCurveAtTime(envelope, start, duration);
    oscillator.connect(gain).connect(this.context.destination);
    this.tones.set(oscillator, gain);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      this.tones.delete(oscillator);
    };
    oscillator.start(start);
    oscillator.stop(start + duration);
  }

  captured(): void {
    // Staggered envelopes keep the combined peak below full scale.
    this.tone(523.25, 0, 0.11, 0.8);
    this.tone(659.25, 0.05, 0.11, 0.68);
  }

  processing(): void {
    clearTimeout(this.timer);
    const pulse = () => {
      this.tone(349.23, 0, 0.25, 0.62);
      this.tone(440, 0.025, 0.2, 0.24);
      this.timer = setTimeout(pulse, 2800);
    };
    this.timer = setTimeout(pulse, 700);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const [oscillator, gain] of this.tones) {
      gain.gain.cancelScheduledValues(this.context.currentTime);
      gain.gain.setValueAtTime(0, this.context.currentTime);
      try { oscillator.stop(); } catch { /* It may already have ended. */ }
      oscillator.disconnect();
      gain.disconnect();
      oscillator.onended = null;
    }
    this.tones.clear();
  }
}
