/**
 * Physiological race simulator — drives the app with no hardware.
 *
 * It plays a compressed HYROX race, producing beat-by-beat R-R intervals and a
 * pace stream. The R-R series is deliberately shaped so DFA-α1 behaves the way
 * the literature says it should: ~1.0 at easy intensity, falling toward ~0.5 as
 * the effort approaches threshold, and below 0.5 in the severe domain. RSA
 * modulation at a breathing frequency gives the respiration estimator a real
 * signal to find. A small, configurable artifact rate exercises the cleaner.
 */

import type { HRSample, PaceSample, AthleteProfile } from "../types";
import { buildRace } from "../data/hyrox";

interface SegPhys {
  /** target intensity as %HRmax (0..1) */
  intensity: number;
  /** running speed m/s (0 ≈ stationary station work) */
  speed: number;
}

// Per-station physiology keyed by station id; runs handled separately.
const STATION_PHYS: Record<string, SegPhys> = {
  ski: { intensity: 0.85, speed: 0.05 },
  "sled-push": { intensity: 0.92, speed: 0.35 },
  "sled-pull": { intensity: 0.9, speed: 0.3 },
  "burpee-bj": { intensity: 0.93, speed: 0.4 },
  row: { intensity: 0.86, speed: 0.05 },
  farmers: { intensity: 0.89, speed: 1.0 },
  lunges: { intensity: 0.9, speed: 0.55 },
  "wall-balls": { intensity: 0.94, speed: 0.05 },
};

type HRCb = (s: HRSample) => void;
type PaceCb = (s: PaceSample) => void;

export interface SimOptions {
  /** baseline artifact injection probability per beat (0..1) */
  artifactRate?: number;
  /** multiply real time so the race progresses faster (segments only) */
  segmentSpeedup?: number;
  /**
   * Workout mode: drive HR toward a plan's target at a given elapsed second.
   * Return a target bpm, or null to fall back to the HYROX physiology.
   */
  targetHrFn?: (elapsedSec: number) => number | null;
}

export class RaceSimulator {
  private race = buildRace();
  private beatTimer: number | null = null;
  private paceTimer: number | null = null;
  private running = false;

  private nowMs = 0; // virtual race clock (ms)
  private hr = 0;
  private targetHr = 0;
  private smooth = 0; // EMA noise state (for DFA shaping)
  private breathPhase = 0; // RSA time accumulator, seconds
  private beatIndex = 0; // parity for the anti-correlated component

  private artifactRate: number;
  private segmentSpeedup: number;
  private targetHrFn?: (elapsedSec: number) => number | null;
  private startedAt = 0; // real ms when start() was called (for plan timing)

  constructor(
    private profile: AthleteProfile,
    private onHR: HRCb,
    private onPace: PaceCb,
    opts: SimOptions = {}
  ) {
    this.artifactRate = opts.artifactRate ?? 0.012;
    this.segmentSpeedup = opts.segmentSpeedup ?? 1;
    this.targetHrFn = opts.targetHrFn;
    this.hr = profile.restHr + 70; // start warmed-up (~120-ish)
    this.targetHr = this.hr;
  }

  setProfile(p: AthleteProfile) {
    this.profile = p;
  }

  /** Total planned race seconds (compressed). */
  get plannedTotalSec(): number {
    return this.race.reduce((a, s) => a + s.plannedSec, 0);
  }

  /** Which planned segment index is active at a given elapsed second. */
  segmentAt(elapsedSec: number): number {
    let acc = 0;
    for (let i = 0; i < this.race.length; i++) {
      acc += this.race[i].plannedSec;
      if (elapsedSec < acc) return i;
    }
    return this.race.length - 1;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.timeOrigin + performance.now();
    this.prefill();
    this.scheduleBeat();
    this.emitPace();
    this.paceTimer = window.setInterval(() => this.emitPace(), 1000);
  }

  private elapsedSec(): number {
    return (performance.timeOrigin + performance.now() - this.startedAt) / 1000;
  }

  /** Warm-up target used during lead-in / when the plan has no HR target. */
  private warmupHr(): number {
    return this.profile.restHr + 0.48 * (this.profile.maxHr - this.profile.restHr);
  }

  stop(): void {
    this.running = false;
    if (this.beatTimer) window.clearTimeout(this.beatTimer);
    if (this.paceTimer) window.clearInterval(this.paceTimer);
    this.beatTimer = null;
    this.paceTimer = null;
  }

  /** Seed ~90 s of backdated beats so DFA/HRV/respiration are ready fast. */
  private prefill(): void {
    const realNow = performance.timeOrigin + performance.now();
    const span = 90_000;
    let backT = realNow - span;
    let vClock = 0;
    let hr = this.profile.restHr + 64;
    let smooth = 0;
    let phase = 0;
    this.beatIndex = 0; // reset parity so repeat starts shape DFA identically
    while (backT < realNow - 200) {
      const phys = this.physAt(vClock / 1000);
      const intensity = this.targetHrFn ? clamp01(this.warmupHr() / this.profile.maxHr) : phys.intensity;
      const tHr = this.profile.maxHr * intensity;
      hr += (tHr - hr) * 0.02;
      const { rr, nextSmooth, nextPhase } = this.makeRR(hr, intensity, smooth, phase);
      smooth = nextSmooth;
      phase = nextPhase;
      const rrVal = this.maybeArtifact(rr);
      this.onHR({ t: backT, hr: Math.round(hr), rr: [rrVal], source: "sim" });
      backT += rr;
      vClock += rr;
    }
    this.nowMs = vClock;
    this.hr = hr;
    this.smooth = smooth;
    this.breathPhase = phase;
  }

  private scheduleBeat(): void {
    if (!this.running) return;

    let intensity: number;
    if (this.targetHrFn) {
      // Workout mode: chase the plan's target HR (or warm up if none yet).
      const t = this.targetHrFn(this.elapsedSec());
      const target = t ?? this.warmupHr();
      this.targetHr = target;
      intensity = clamp01(target / this.profile.maxHr);
    } else {
      const phys = this.physAt(this.nowMs / 1000);
      this.targetHr = this.profile.maxHr * phys.intensity + this.driftBonus();
      intensity = phys.intensity;
    }

    // First-order HR response toward target.
    this.hr += (this.targetHr - this.hr) * 0.06;
    const hr = Math.max(60, Math.min(this.profile.maxHr + 4, this.hr));

    const { rr, nextSmooth, nextPhase } = this.makeRR(hr, intensity, this.smooth, this.breathPhase);
    this.smooth = nextSmooth;
    this.breathPhase = nextPhase;

    const rrVal = this.maybeArtifact(rr);
    const realNow = performance.timeOrigin + performance.now();
    this.onHR({ t: realNow, hr: Math.round(hr), rr: [rrVal], source: "sim" });

    this.nowMs += rr * this.segmentSpeedup;
    this.beatTimer = window.setTimeout(() => this.scheduleBeat(), rr);
  }

  /** Physiology for the segment active at elapsedSec (loops at race end). */
  private physAt(elapsedSec: number): SegPhys {
    const total = this.plannedTotalSec;
    const e = elapsedSec % total;
    const seg = this.race[this.segmentAt(e)];
    if (seg.kind === "run") {
      // Compromised running: 0.83 → 0.87 %HRmax, climbing through the race.
      return { intensity: 0.83, speed: 3.25 };
    }
    return STATION_PHYS[seg.station!.id] ?? { intensity: 0.86, speed: 0.1 };
  }

  /** Slow upward cardiac drift across the race (bpm added to target). */
  private driftBonus(): number {
    const frac = (this.nowMs / 1000) / this.plannedTotalSec;
    return Math.min(frac, 1) * 6;
  }

  /**
   * Build one R-R interval (ms) with intensity-dependent variability,
   * DFA-shaping, and RSA. `phase` is the RSA time accumulator (seconds).
   */
  private makeRR(
    hr: number,
    intensity: number,
    smooth: number,
    phase: number
  ): { rr: number; nextSmooth: number; nextPhase: number } {
    const meanRR = 60000 / hr;

    // Variability shrinks as intensity rises (sympathetic dominance).
    const sd = Math.max(3, 42 * (1.05 - intensity)); // ms

    const white = gaussian();

    // Correlated (low-frequency) EMA component — weight high when easy, which
    // adds long-range correlation and pushes α1 toward 1.0.
    const corrW = clamp01(1.15 - intensity);
    const a = 0.85; // EMA memory
    const nextSmooth = a * smooth + (1 - a) * white;

    // Anti-correlated (alternating) component grows in the severe domain,
    // pulling α1 below 0.5 when intensity is very high.
    const antiW = clamp01((intensity - 0.9) * 4);
    const anti = (this.beatIndex % 2 === 0 ? 1 : -1) * Math.abs(gaussian()) * 0.7;
    this.beatIndex++;

    const shaped = (1 - corrW - antiW * 0.5) * white + corrW * nextSmooth * 2.2 + antiW * anti;

    // RSA: breathing modulation, faster + shallower as intensity climbs.
    const breathHz = 0.2 + intensity * 0.45; // ~0.2..0.65 Hz
    const dtSec = meanRR / 1000;
    const nextPhase = phase + dtSec;
    const rsaAmp = Math.max(2, 26 * (1.1 - intensity)); // ms
    const rsa = rsaAmp * Math.sin(2 * Math.PI * breathHz * nextPhase);

    let rr = meanRR + sd * shaped + rsa;
    rr = Math.max(280, Math.min(1600, rr));
    return { rr, nextSmooth, nextPhase };
  }

  private maybeArtifact(rr: number): number {
    if (Math.random() < this.artifactRate) {
      // missed beat (double) or extra beat (half)
      return Math.random() < 0.5 ? rr * 2 : rr * 0.5;
    }
    return rr;
  }

  private emitPace(): void {
    if (!this.running) return;
    if (this.targetHrFn) {
      // Workout mode: HR-target driven, no GPS pace.
      this.onPace({ t: performance.timeOrigin + performance.now(), speedMps: 0, source: "sim" });
      return;
    }
    const phys = this.physAt(this.nowMs / 1000);
    const jitter = phys.speed > 1 ? (Math.random() - 0.5) * 0.3 : 0;
    this.onPace({ t: performance.timeOrigin + performance.now(), speedMps: Math.max(0, phys.speed + jitter), source: "sim" });
  }

  setArtifactRate(r: number) {
    this.artifactRate = r;
  }
}

/* ---- helpers ---- */

let spare: number | null = null;
function gaussian(): number {
  // Box–Muller with cached spare.
  if (spare !== null) {
    const s = spare;
    spare = null;
    return s;
  }
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
