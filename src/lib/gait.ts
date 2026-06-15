/**
 * Running gait metrics from 2D pose landmarks (BlazePose / MediaPipe).
 *
 * Implements the feasible-in-browser subset of the "Running Cadence & Form
 * Analysis" spec: cadence is the validated trust anchor (Young et al. 2023,
 * Sensors 23(2):696 — ICC 0.981 vs Vicon); overstride is the headline form
 * metric (shank angle at initial contact + normalized foot-ahead distance);
 * plus vertical oscillation, trunk lean, knee drive and a L/R timing-balance
 * proxy. Ground-contact-time and foot-strike pattern are NOT computed here —
 * they need 120–240 fps, which phone cameras don't reliably deliver; the UI
 * flags them as out of scope rather than reporting weak numbers.
 *
 * All inputs are normalized image coordinates (x,y in [0,1], y increasing
 * DOWNWARD), matching MediaPipe's output. Everything is unit-testable: feed
 * synthetic landmark frames to GaitAnalyzer and read snapshot() — see
 * selfTestGait() at the bottom.
 */

export interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}
export type Landmarks = Landmark[]; // length 33 (BlazePose)

// BlazePose landmark indices we use.
export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
  L_HEEL: 29,
  R_HEEL: 30,
  L_FOOT: 31,
  R_FOOT: 32,
} as const;

/** Skeleton edges for drawing (pairs of landmark indices). */
export const POSE_EDGES: [number, number][] = [
  [11, 12], [11, 23], [12, 24], [23, 24], // torso
  [11, 13], [13, 15], [12, 14], [14, 16], // arms
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], // left leg+foot
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], // right leg+foot
];

const RAD2DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ */
/* One-Euro filter — low-lag smoothing for noisy landmark signals.     */
/* (Casiez, Roussel & Vogel, CHI 2012 — the spec's recommended filter.) */
/* ------------------------------------------------------------------ */
export class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;
  constructor(private minCutoff = 1.4, private beta = 0.5, private dCutoff = 1.0) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev == null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

/* ------------------------------------------------------------------ */
/* Step detector — counts footfalls per foot from the ankle vertical    */
/* signal via threshold-crossing with an adaptive amplitude estimate    */
/* and a refractory period. Reports the peak (≈ initial contact) instant.*/
/* ------------------------------------------------------------------ */
interface StepEvent {
  t: number; // time of the peak (≈ contact)
}
interface StepUpdate {
  event: StepEvent | null;
  /** true on the frame where the running peak (≈ contact instant) advanced —
   *  callers snapshot strike geometry here so it reflects contact, not late swing. */
  peakAdvanced: boolean;
}
class StepDetector {
  private mu = 0; // slow mean
  private amp = 0; // amplitude estimate (EMA of |y-mu|)
  private active = false; // above the high threshold
  private peakT = 0;
  private peakY = -Infinity;
  private lastStepT = -Infinity;
  private started = false;
  /** refractoryMs: min ms between same-foot contacts (250 ms ≈ 240 spm full cadence). */
  constructor(private refractoryMs = 250) {}

  /** Feed a sample; reports a confirmed contact and whether the peak advanced. */
  update(t: number, y: number): StepUpdate {
    if (!this.started) {
      this.mu = y;
      this.amp = 0.005;
      this.started = true;
      return { event: null, peakAdvanced: false };
    }
    // slow trackers
    this.mu += 0.02 * (y - this.mu);
    this.amp += 0.02 * (Math.abs(y - this.mu) - this.amp);
    const a = Math.max(this.amp, 0.004); // floor so tiny jitter never triggers
    const hi = this.mu + 0.45 * a;
    const lo = this.mu - 0.1 * a;

    let event: StepEvent | null = null;
    let peakAdvanced = false;
    if (!this.active) {
      if (y > hi) {
        this.active = true;
        this.peakY = y;
        this.peakT = t;
        peakAdvanced = true; // entered the contact excursion
      }
    } else {
      if (y > this.peakY) {
        this.peakY = y;
        this.peakT = t;
        peakAdvanced = true; // new lowest-foot point ≈ contact instant
      }
      if (y < lo) {
        // excursion finished — register the contact at its lowest point (max y)
        this.active = false;
        if (this.peakT - this.lastStepT >= this.refractoryMs) {
          this.lastStepT = this.peakT;
          event = { t: this.peakT };
        }
      }
    }
    return { event, peakAdvanced };
  }
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                     */
/* ------------------------------------------------------------------ */
function mid(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) };
}
function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
/** Angle of vector (a→b) from the vertical axis, in degrees. +x component → positive. */
function angleFromVertical(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay; // image y is downward
  // vertical reference is straight down (0,+1); angle off vertical:
  return Math.atan2(dx, dy) * RAD2DEG;
}

/* ------------------------------------------------------------------ */
/* Rolling helpers                                                      */
/* ------------------------------------------------------------------ */
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export interface GaitSnapshot {
  /** steps per minute (both feet) — the validated trust anchor */
  cadenceSpm: number | null;
  /** 0..1 confidence in cadence (enough steps + landmark visibility) */
  cadenceConfidence: number;
  /** estimated vertical oscillation of the pelvis, cm (scale-estimated) */
  verticalOscCm: number | null;
  /** trunk lean from vertical, degrees (magnitude; forward when running) */
  trunkLeanDeg: number | null;
  /** shank angle at initial contact, degrees; + = foot ahead of knee = overstride */
  overstrideShankDeg: number | null;
  /** foot landing ahead of hips at contact, % of leg length; + = ahead */
  footAheadPct: number | null;
  /** true when the runner is overstriding (shank clearly forward at contact) */
  overstriding: boolean;
  /** peak knee lift during swing, % of leg length */
  kneeDrivePct: number | null;
  /** L↔R timing balance, % (50 = even) */
  balancePct: number | null;
  /** total steps counted this session */
  steps: number;
  /** mean landmark visibility 0..1 (overall tracking quality) */
  quality: number;
}

interface FootState {
  euro: OneEuro;
  det: StepDetector;
  stepTimes: number[]; // contact timestamps
  // geometry snapshotted at the developing peak (≈ contact), committed on the contact event
  candShank: number;
  candFootAhead: number;
  shankAtIC: number[]; // committed per contact
  footAheadAtIC: number[];
  kneeHist: { t: number; y: number }[]; // for knee-lift excursion
}

const CAD_WINDOW_STEPS = 16; // intervals kept for the rolling cadence median
const IC_WINDOW = 12; // contacts kept for overstride averaging
const VO_WINDOW_MS = 1400;

export class GaitAnalyzer {
  private left: FootState = this.newFoot();
  private right: FootState = this.newFoot();
  private allSteps: { t: number; foot: "L" | "R" }[] = [];

  // pelvis vertical oscillation tracking (rolling min/max)
  private pelvisEuro = new OneEuro(1.2, 0.4);
  private pelvisHist: { t: number; y: number }[] = [];
  private voCm: number[] = [];

  private trunk: number[] = [];
  private kneeDrive: number[] = [];
  private visSum = 0;
  private visN = 0;
  private lastT = 0;
  private firstT = 0;
  private totalStepCount = 0; // true session total (never capped)

  private newFoot(): FootState {
    return {
      euro: new OneEuro(1.4, 0.5),
      det: new StepDetector(250),
      stepTimes: [],
      candShank: 0,
      candFootAhead: 0,
      shankAtIC: [],
      footAheadAtIC: [],
      kneeHist: [],
    };
  }

  reset(): void {
    this.left = this.newFoot();
    this.right = this.newFoot();
    this.allSteps = [];
    this.pelvisEuro = new OneEuro(1.2, 0.4);
    this.pelvisHist = [];
    this.voCm = [];
    this.trunk = [];
    this.kneeDrive = [];
    this.visSum = 0;
    this.visN = 0;
    this.lastT = 0;
    this.firstT = 0;
    this.totalStepCount = 0;
  }

  /** Direction the runner faces in image-x (toes ahead of heel). +1 → +x. */
  private forwardSign(lm: Landmarks): number {
    const lf = lm[LM.L_FOOT], lh = lm[LM.L_HEEL], rf = lm[LM.R_FOOT], rh = lm[LM.R_HEEL];
    let s = 0;
    if (lf && lh) s += lf.x - lh.x;
    if (rf && rh) s += rf.x - rh.x;
    return s >= 0 ? 1 : -1;
  }

  push(tMs: number, lm: Landmarks): void {
    if (!lm || lm.length < 33) return;
    if (!this.firstT) this.firstT = tMs;
    this.lastT = tMs;

    const lHip = lm[LM.L_HIP], rHip = lm[LM.R_HIP];
    const lSh = lm[LM.L_SHOULDER], rSh = lm[LM.R_SHOULDER];
    if (!lHip || !rHip || !lSh || !rSh) return;
    const hipMid = mid(lHip, rHip);
    const shMid = mid(lSh, rSh);
    const fwd = this.forwardSign(lm);

    // overall quality (visibility of the core landmarks)
    for (const i of [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.L_SHOULDER, LM.R_SHOULDER]) {
      this.visSum += lm[i]?.visibility ?? 0;
      this.visN += 1;
    }

    // --- trunk lean (shoulder-mid relative to hip-mid, from vertical) ---
    // torso points "up" (decreasing y), so measure hip→shoulder against up-axis.
    const tdx = shMid.x - hipMid.x;
    const tdy = hipMid.y - shMid.y; // positive when shoulders above hips
    if (tdy > 1e-4) this.trunk.push(Math.atan2(Math.abs(tdx), tdy) * RAD2DEG);
    if (this.trunk.length > 240) this.trunk.shift();

    // --- vertical oscillation: pelvis-mid excursion, scaled by leg length ---
    const legPx = this.legLength(lm);
    const py = this.pelvisEuro.filter(hipMid.y, tMs);
    this.pelvisHist.push({ t: tMs, y: py });
    while (this.pelvisHist.length && tMs - this.pelvisHist[0].t > VO_WINDOW_MS) this.pelvisHist.shift();
    if (this.pelvisHist.length > 5 && legPx > 1e-3) {
      let lo = Infinity, hi = -Infinity;
      for (const p of this.pelvisHist) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
      const excursionNorm = (hi - lo) / legPx; // fraction of leg length
      // leg length ≈ 0.48 × height; assume ~0.92 m leg → cm via excursion fraction
      this.voCm.push(excursionNorm * 92);
      if (this.voCm.length > 90) this.voCm.shift();
    }

    // --- per-foot processing ---
    this.foot(this.left, "L", lm[LM.L_ANKLE], lm[LM.L_KNEE], lm[LM.L_FOOT], lm[LM.L_HEEL], hipMid, legPx, fwd, tMs);
    this.foot(this.right, "R", lm[LM.R_ANKLE], lm[LM.R_KNEE], lm[LM.R_FOOT], lm[LM.R_HEEL], hipMid, legPx, fwd, tMs);
  }

  private legLength(lm: Landmarks): number {
    const l = lm[LM.L_HIP] && lm[LM.L_KNEE] && lm[LM.L_ANKLE]
      ? dist(lm[LM.L_HIP], lm[LM.L_KNEE]) + dist(lm[LM.L_KNEE], lm[LM.L_ANKLE]) : 0;
    const r = lm[LM.R_HIP] && lm[LM.R_KNEE] && lm[LM.R_ANKLE]
      ? dist(lm[LM.R_HIP], lm[LM.R_KNEE]) + dist(lm[LM.R_KNEE], lm[LM.R_ANKLE]) : 0;
    return Math.max(l, r);
  }

  private foot(
    f: FootState, side: "L" | "R",
    ankle: Landmark | undefined, knee: Landmark | undefined,
    foot: Landmark | undefined, _heel: Landmark | undefined,
    hipMid: Landmark, legPx: number, fwd: number, tMs: number
  ): void {
    if (!ankle || !knee) return;
    const ay = f.euro.filter(ankle.y, tMs);

    // knee-lift excursion: peak-to-trough of knee height over a short window
    // (positive; larger = the knee rises higher during swing).
    if (legPx > 1e-3) {
      f.kneeHist.push({ t: tMs, y: knee.y });
      while (f.kneeHist.length && tMs - f.kneeHist[0].t > VO_WINDOW_MS) f.kneeHist.shift();
      if (f.kneeHist.length > 5) {
        let lo = Infinity, hi = -Infinity;
        for (const p of f.kneeHist) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
        this.kneeDrive.push((hi - lo) / legPx);
        if (this.kneeDrive.length > 240) this.kneeDrive.shift();
      }
    }

    const r = f.det.update(tMs, ay);
    // Snapshot strike geometry AT the developing contact peak (not when the
    // excursion later ends), so shank angle reflects initial contact.
    if (r.peakAdvanced && legPx > 1e-3) {
      f.candShank = angleFromVertical(knee.x, knee.y, ankle.x, ankle.y) * fwd;
      f.candFootAhead = ((ankle.x - hipMid.x) * fwd) / legPx * 100;
    }
    if (r.event) {
      this.totalStepCount += 1;
      f.stepTimes.push(r.event.t);
      if (f.stepTimes.length > CAD_WINDOW_STEPS + 2) f.stepTimes.shift();
      this.allSteps.push({ t: r.event.t, foot: side });
      if (this.allSteps.length > 64) this.allSteps.shift();
      f.shankAtIC.push(f.candShank);
      f.footAheadAtIC.push(f.candFootAhead);
      if (f.shankAtIC.length > IC_WINDOW) f.shankAtIC.shift();
      if (f.footAheadAtIC.length > IC_WINDOW) f.footAheadAtIC.shift();
      void foot; // foot landmark reserved for future foot-strike work
    }
  }

  /** Are both feet currently contributing contacts? (side-view often occludes one.) */
  private bothFeetTracked(): boolean {
    const recent = this.allSteps.slice(-CAD_WINDOW_STEPS);
    const nL = recent.filter((s) => s.foot === "L").length;
    const nR = recent.filter((s) => s.foot === "R").length;
    return nL >= 2 && nR >= 2;
  }

  /** Cadence from the rolling median inter-contact interval. */
  private cadence(): number | null {
    const times = this.allSteps.map((s) => s.t).slice(-CAD_WINDOW_STEPS);
    if (times.length < 4) return null;
    const intervals: number[] = [];
    for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
    const m = median(intervals);
    if (!(m > 0)) return null;
    // Both feet alternating → each interval is one step. If only one foot is
    // tracked (far leg occluded), each interval is a full stride = two steps —
    // so double, instead of silently reporting half the true cadence.
    return this.bothFeetTracked() ? 60000 / m : 120000 / m;
  }

  private balance(): number | null {
    // share of alternation gaps that are L→R vs R→L (50 = symmetric)
    const s = this.allSteps.slice(-16);
    if (s.length < 6) return null;
    let lr = 0, rl = 0, nLR = 0, nRL = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i].foot === s[i - 1].foot) continue;
      const gap = s[i].t - s[i - 1].t;
      if (s[i - 1].foot === "L") { lr += gap; nLR++; } else { rl += gap; nRL++; }
    }
    if (!nLR || !nRL) return null;
    const a = lr / nLR, b = rl / nRL;
    return (a / (a + b)) * 100;
  }

  snapshot(): GaitSnapshot {
    const cad = this.cadence();
    const shank = [...this.left.shankAtIC, ...this.right.shankAtIC];
    const ahead = [...this.left.footAheadAtIC, ...this.right.footAheadAtIC];
    const quality = this.visN ? this.visSum / this.visN : 0;
    const nSteps = this.allSteps.length;
    const both = this.bothFeetTracked();
    const cadConf = Math.max(0, Math.min(1, (nSteps >= 6 ? 1 : nSteps / 6) * Math.min(1, quality / 0.6) * (both ? 1 : 0.8)));
    const shankAvg = shank.length >= 3 ? mean(shank) : null;
    return {
      cadenceSpm: cad != null ? Math.round(cad) : null,
      cadenceConfidence: cadConf,
      verticalOscCm: this.voCm.length >= 6 ? +median(this.voCm).toFixed(1) : null,
      trunkLeanDeg: this.trunk.length >= 10 ? +median(this.trunk).toFixed(1) : null,
      overstrideShankDeg: shankAvg != null ? +shankAvg.toFixed(1) : null,
      footAheadPct: ahead.length >= 3 ? +mean(ahead).toFixed(1) : null,
      overstriding: shankAvg != null ? shankAvg > 5 : false,
      kneeDrivePct: this.kneeDrive.length >= 10 ? +(median(this.kneeDrive) * 100).toFixed(0) : null,
      balancePct: this.balance(),
      steps: this.totalStepCount,
      quality: +quality.toFixed(2),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Self-test — synthetic runner at a known cadence; verifies the engine */
/* recovers it. Run in dev (see App selfTest hook).                     */
/* ------------------------------------------------------------------ */
export function selfTestGait(): { ok: boolean; detail: string } {
  const fps = 60;
  const durSec = 12;
  const targetSpm = 180; // both feet → 90 per foot → 1.5 Hz per foot
  const fPerFoot = targetSpm / 2 / 60; // Hz
  const blank = (): Landmark => ({ x: 0.5, y: 0.5, visibility: 0.95 });

  // Build a frame for a runner whose foot leads forward (+x) at contact and
  // swings back — so overstride timing is genuinely exercised.
  const frame = (i: number): Landmarks => {
    const lm: Landmarks = Array.from({ length: 33 }, blank);
    const phase = 2 * Math.PI * fPerFoot * (i / fps);
    lm[LM.L_SHOULDER] = { x: 0.50, y: 0.30, visibility: 0.95 };
    lm[LM.R_SHOULDER] = { x: 0.52, y: 0.30, visibility: 0.95 };
    lm[LM.L_HIP] = { x: 0.50, y: 0.50, visibility: 0.95 };
    lm[LM.R_HIP] = { x: 0.52, y: 0.50, visibility: 0.95 };
    lm[LM.L_KNEE] = { x: 0.50, y: 0.62 + 0.06 * Math.cos(phase), visibility: 0.95 };
    lm[LM.R_KNEE] = { x: 0.52, y: 0.62 + 0.06 * Math.cos(phase + Math.PI), visibility: 0.95 };
    // ankle y dips lowest (max y) at contact (sin=+1); ankle x leads forward there too.
    lm[LM.L_ANKLE] = { x: 0.50 + 0.04 * Math.sin(phase), y: 0.86 + 0.03 * Math.sin(phase), visibility: 0.95 };
    lm[LM.R_ANKLE] = { x: 0.52 + 0.04 * Math.sin(phase + Math.PI), y: 0.86 + 0.03 * Math.sin(phase + Math.PI), visibility: 0.95 };
    lm[LM.L_HEEL] = { x: 0.49, y: 0.88, visibility: 0.9 };
    lm[LM.R_HEEL] = { x: 0.51, y: 0.88, visibility: 0.9 };
    lm[LM.L_FOOT] = { x: 0.53, y: 0.88, visibility: 0.9 }; // toes ahead (+x) → forward = +x
    lm[LM.R_FOOT] = { x: 0.55, y: 0.88, visibility: 0.9 };
    return lm;
  };

  // 1) Both feet → cadence and a clear overstride (+shank at contact).
  const a = new GaitAnalyzer();
  for (let i = 0; i < durSec * fps; i++) a.push((i / fps) * 1000, frame(i));
  const s = a.snapshot();
  const cad = s.cadenceSpm ?? 0;
  const cadOk = Math.abs(cad - targetSpm) <= 8;
  const overOk = (s.overstrideShankDeg ?? 0) > 5 && s.overstriding === true;

  // 2) One foot occluded → cadence must NOT halve (doubling fallback).
  const b = new GaitAnalyzer();
  for (let i = 0; i < durSec * fps; i++) {
    const lm = frame(i);
    (lm as unknown as (Landmark | undefined)[])[LM.R_ANKLE] = undefined; // far leg occluded
    b.push((i / fps) * 1000, lm);
  }
  const cad1 = b.snapshot().cadenceSpm ?? 0;
  const oneFootOk = Math.abs(cad1 - targetSpm) <= 12;

  const ok = cadOk && overOk && oneFootOk;
  return {
    ok,
    detail: `cadence=${cad}(±8 of ${targetSpm}):${cadOk} · overstride=${s.overstrideShankDeg}°/${s.overstriding}:${overOk} · 1-foot cadence=${cad1}:${oneFootOk}`,
  };
}
