/**
 * Web Audio cadence metronome — one click per step at the target spm.
 *
 * The spec recommends an audible metronome as the cadence-retraining cue
 * (cadence retraining is the best-evidenced injury intervention: a moderate
 * 5–10% increase reduces loading rates and injury risk). Uses lookahead
 * scheduling so timing stays rock-steady regardless of the render loop.
 */
export class Metronome {
  private ctx: AudioContext | null = null;
  private spm: number;
  private timer: number | null = null;
  private nextTime = 0;
  private running = false;
  private accent = false;
  private beat = 0;
  private readonly lookaheadMs = 25;
  private readonly scheduleAheadSec = 0.12;

  constructor(spm = 180, accentEveryOther = false) {
    this.spm = spm;
    this.accent = accentEveryOther;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setSpm(spm: number): void {
    this.spm = Math.max(120, Math.min(220, spm));
  }

  start(): void {
    if (this.running) return;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    }
    void this.ctx.resume();
    this.running = true;
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.scheduler();
  }

  stop(): void {
    this.running = false;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }

  private scheduler = (): void => {
    if (!this.running || !this.ctx) return;
    const interval = 60 / this.spm; // seconds per step
    while (this.nextTime < this.ctx.currentTime + this.scheduleAheadSec) {
      this.click(this.nextTime, this.accent && this.beat % 2 === 0);
      this.nextTime += interval;
      this.beat++;
    }
    this.timer = window.setTimeout(this.scheduler, this.lookaheadMs);
  };

  private click(at: number, strong: boolean): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = strong ? 1500 : 1100;
    const peak = strong ? 0.5 : 0.32;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }
}
