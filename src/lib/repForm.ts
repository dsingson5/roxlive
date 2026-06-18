/**
 * Camera rep-counting + strength form analysis engine (2D pose).
 *
 * Implements the "Camera-Based Rep Counting & Strength Form Analysis" spec:
 * a DATA-DRIVEN engine over MediaPipe/BlazePose 2D landmarks. Each movement is
 * described by an {@link Exercise} ruleset (primary angle signal, a two-state
 * rep machine with HYSTERESIS, tempo phases, and CSCS-mapped form checks). New
 * movements are data ({@link EXERCISES} in ./exercises), not code.
 *
 * Honest about 2D limits (the spec's safety framing): frontal-plane checks
 * (knee valgus) and spine flexion are weakly observable in 2D — those checks
 * carry `reliability: "low_2d"` and the UI must present everything as a coaching
 * aid, never a clinical measurement (relevant to David's tibial bone-stress
 * history). Reuses the One-Euro filter + landmark indices from ./gait.
 *
 * Pure + unit-testable: feed synthetic landmark frames to RepFormAnalyzer and
 * read snapshot()/report() — see selfTestRepForm() at the bottom.
 */

import { OneEuro, LM, type Landmark, type Landmarks } from "./gait";

const RAD2DEG = 180 / Math.PI;
// Arm indices BlazePose doesn't expose in gait's LM.
const L_ELBOW = 13, R_ELBOW = 14, L_WRIST = 15, R_WRIST = 16;

export type View = "sagittal" | "frontal" | "either";
export type Severity = "info" | "warn" | "fault";
/** Scalars the engine can compute from one landmark frame. */
export type MetricKey =
  | "kneeAngle"      // hip–knee–ankle (°) — squat/lunge depth signal
  | "hipAngle"       // shoulder–hip–knee (°) — hinge/press-up signal
  | "elbowAngle"     // shoulder–elbow–wrist (°) — press/pull signal
  | "trunkLean"      // torso from vertical (°)
  | "depthHipKnee"   // (hipY − kneeY)×100; +ve = hip below knee (squat depth)
  | "kneeValgusPct"; // knee horizontal deviation from ankle, % leg length (frontal, low-2D)

export interface FormCheck {
  code: string;
  metric: MetricKey;
  /** which per-rep aggregate to test: the deepest frame, or the rep max/min. */
  at: "bottom" | "max" | "min";
  op: ">" | "<" | ">=" | "<=";
  /** fault when `aggregate op value` is true. */
  value: number;
  fault: string;
  cue: string;
  severity: Severity;
  /** check only applies when filmed from this view (default: the exercise view). */
  view?: View;
  /** "low_2d" → weakly observable in 2D; UI down-weights + disclaims. */
  reliability?: "ok" | "low_2d";
}

export interface Exercise {
  id: string;
  name: string;
  view: View;
  /** rep-counting primary signal (degrees). */
  primary: MetricKey;
  /** A-state ("start/extended/locked"): primary ≥ topEnter.
   *  B-state ("working extreme"): primary ≤ bottomEnter. The gap is the
   *  hysteresis band that stops a wobble near one threshold double-counting. */
  topEnter: number;
  bottomEnter: number;
  /** how the rom is described for the "didn't reach depth" info nudge. */
  romLabel?: string;
  tempoPhases?: string[];
  formChecks: FormCheck[];
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Geometry / per-frame metrics                                        */
/* ------------------------------------------------------------------ */

function v(p?: Landmark): number {
  return p?.visibility ?? 0;
}
/** Included angle at vertex b (a–b–c), degrees. */
export function angle(a: Landmark, b: Landmark, c: Landmark): number {
  const abx = a.x - b.x, aby = a.y - b.y, cbx = c.x - b.x, cby = c.y - b.y;
  const m = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (m < 1e-9) return NaN; // degenerate (coincident landmarks) → undefined angle
  return Math.acos(Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / m))) * RAD2DEG;
}
function mid(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(v(a), v(b)) };
}
function legSide(lm: Landmarks): "L" | "R" {
  const l = v(lm[LM.L_HIP]) + v(lm[LM.L_KNEE]) + v(lm[LM.L_ANKLE]);
  const r = v(lm[LM.R_HIP]) + v(lm[LM.R_KNEE]) + v(lm[LM.R_ANKLE]);
  return r > l ? "R" : "L";
}
function armSide(lm: Landmarks): "L" | "R" {
  const l = v(lm[LM.L_SHOULDER]) + v(lm[L_ELBOW]) + v(lm[L_WRIST]);
  const r = v(lm[LM.R_SHOULDER]) + v(lm[R_ELBOW]) + v(lm[R_WRIST]);
  return r > l ? "R" : "L";
}
const VIS_MIN = 0.3;
function ok(...ps: (Landmark | undefined)[]): boolean {
  return ps.every((p) => p && v(p) >= VIS_MIN);
}

export type FrameMetrics = Partial<Record<MetricKey, number>>;

/** Compute every metric from one frame (omits any that aren't trackable). */
export function frameMetrics(lm: Landmarks): FrameMetrics {
  const out: FrameMetrics = {};
  if (!lm || lm.length < 33) return out;
  const ls = legSide(lm);
  const hip = lm[ls === "R" ? LM.R_HIP : LM.L_HIP];
  const knee = lm[ls === "R" ? LM.R_KNEE : LM.L_KNEE];
  const ankle = lm[ls === "R" ? LM.R_ANKLE : LM.L_ANKLE];
  const sh = lm[ls === "R" ? LM.R_SHOULDER : LM.L_SHOULDER];

  if (ok(hip, knee, ankle)) out.kneeAngle = angle(hip, knee, ankle);
  if (ok(sh, hip, knee)) out.hipAngle = angle(sh, hip, knee);
  if (ok(hip, knee)) out.depthHipKnee = (hip.y - knee.y) * 100;
  if (ok(hip, knee, ankle)) {
    const legLen = Math.hypot(hip.x - knee.x, hip.y - knee.y) + Math.hypot(knee.x - ankle.x, knee.y - ankle.y);
    if (legLen > 1e-3) out.kneeValgusPct = (Math.abs(knee.x - ankle.x) / legLen) * 100;
  }

  const as = armSide(lm);
  const ash = lm[as === "R" ? LM.R_SHOULDER : LM.L_SHOULDER];
  const elb = lm[as === "R" ? R_ELBOW : L_ELBOW];
  const wr = lm[as === "R" ? R_WRIST : L_WRIST];
  if (ok(ash, elb, wr)) out.elbowAngle = angle(ash, elb, wr);

  const lSh = lm[LM.L_SHOULDER], rSh = lm[LM.R_SHOULDER], lHip = lm[LM.L_HIP], rHip = lm[LM.R_HIP];
  if (ok(lSh, rSh, lHip, rHip)) {
    const shMid = mid(lSh, rSh), hipMid = mid(lHip, rHip);
    const dx = shMid.x - hipMid.x, dy = hipMid.y - shMid.y; // dy>0 when shoulders above hips
    if (dy > 1e-4) out.trunkLean = Math.atan2(Math.abs(dx), dy) * RAD2DEG;
  }
  // drop any non-finite metric (degenerate landmarks) so checks skip it cleanly
  for (const k of Object.keys(out) as MetricKey[]) if (!Number.isFinite(out[k])) delete out[k];
  return out;
}

/* ------------------------------------------------------------------ */
/* Rep + form analyzer                                                 */
/* ------------------------------------------------------------------ */

export interface RepDetail {
  index: number;
  /** [eccentric, bottomPause, concentric] seconds. */
  tempo: [number, number, number];
  tutSec: number;
  faults: FaultHit[];
}
export interface FaultHit {
  code: string;
  fault: string;
  cue: string;
  severity: Severity;
  reliability: "ok" | "low_2d";
}
export interface RepFormSnapshot {
  reps: number;
  phase: "top" | "descending" | "bottom" | "ascending";
  primary: number | null;
  /** live form flags for the CURRENT frame (real-time correction cues). */
  liveFaults: FaultHit[];
  /** tracking quality 0..1 (mean visibility of the signal joints). */
  quality: number;
  lastRep: RepDetail | null;
}
export interface SetReport {
  exerciseId: string;
  exerciseName: string;
  reps: number;
  reps_detail: RepDetail[];
  /** unique faults across the set, with how many reps each hit. */
  faults: { code: string; fault: string; cue: string; severity: Severity; reliability: "ok" | "low_2d"; reps: number }[];
  /** mean [ecc, bottom, conc] across reps. */
  avgTempo: [number, number, number] | null;
  cleanReps: number;
}

type Phase = "top" | "descending" | "bottom" | "ascending";

function cmp(a: number, op: FormCheck["op"], b: number): boolean {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
  }
}

export class RepFormAnalyzer {
  private euro = new OneEuro(2.0, 0.4); // smooth the primary angle (deg)
  private phase: Phase = "top";
  private primary: number | null = null;
  private reps: RepDetail[] = [];
  private last: FrameMetrics = {};
  private visSum = 0;
  private visN = 0;

  // per-rep accumulators (active between leaving top and returning to top)
  private repMin: FrameMetrics = {};
  private repMax: FrameMetrics = {};
  private bottomMetrics: FrameMetrics = {};
  private repMinPrimary = Infinity;
  private tDescStart = 0;
  private tBottom = 0;
  private tConcStart = 0;
  private sawBottom = false;
  /** only frontal-view checks run when filmed frontally, etc. */
  private filmedView: View;

  constructor(private ex: Exercise, filmedView: View = ex.view) {
    this.filmedView = filmedView;
  }

  reset(): void {
    this.euro = new OneEuro(2.0, 0.4);
    this.phase = "top";
    this.primary = null;
    this.reps = [];
    this.last = {};
    this.visSum = this.visN = 0;
    this.resetRep();
  }
  private resetRep(): void {
    this.repMin = {};
    this.repMax = {};
    this.bottomMetrics = {};
    this.repMinPrimary = Infinity;
    this.sawBottom = false;
  }
  private accumulate(m: FrameMetrics): void {
    for (const k of Object.keys(m) as MetricKey[]) {
      const val = m[k]!;
      if (this.repMin[k] == null || val < this.repMin[k]!) this.repMin[k] = val;
      if (this.repMax[k] == null || val > this.repMax[k]!) this.repMax[k] = val;
    }
  }

  push(tMs: number, lm: Landmarks): void {
    const m = frameMetrics(lm);
    this.last = m;
    // tracking quality from the signal joints
    for (const i of [LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_SHOULDER, LM.R_SHOULDER]) {
      this.visSum += v(lm[i]); this.visN += 1;
    }
    const raw = m[this.ex.primary];
    if (raw == null) return; // signal joints not visible this frame
    const p = this.euro.filter(raw, tMs);
    this.primary = p;
    const { topEnter, bottomEnter } = this.ex;

    // accumulate per-rep extremes + remember the deepest (min-primary) frame
    if (this.phase !== "top") {
      this.accumulate(m);
      if (p < this.repMinPrimary) { this.repMinPrimary = p; this.bottomMetrics = m; }
    }

    switch (this.phase) {
      case "top":
        if (p < topEnter) { this.phase = "descending"; this.resetRep(); this.tDescStart = tMs; this.accumulate(m); this.repMinPrimary = p; this.bottomMetrics = m; }
        break;
      case "descending":
        if (p <= bottomEnter) { this.phase = "bottom"; this.tBottom = tMs; this.sawBottom = true; }
        else if (p >= topEnter) { this.phase = "top"; this.resetRep(); } // aborted partial — no rep, clear accumulators
        break;
      case "bottom":
        if (p > bottomEnter) { this.phase = "ascending"; this.tConcStart = tMs; }
        break;
      case "ascending":
        if (p >= topEnter) { this.completeRep(tMs); this.phase = "top"; }
        else if (p <= bottomEnter) { this.phase = "bottom"; } // re-sank
        break;
    }
  }

  private completeRep(tTop: number): void {
    if (!this.sawBottom) return;
    const ecc = Math.max(0, (this.tBottom - this.tDescStart) / 1000);
    const bot = Math.max(0, (this.tConcStart - this.tBottom) / 1000);
    const con = Math.max(0, (tTop - this.tConcStart) / 1000);
    const faults = this.evalChecks();
    this.reps.push({ index: this.reps.length + 1, tempo: [ecc, bot, con], tutSec: ecc + bot + con, faults });
  }

  private aggForCheck(c: FormCheck): number | undefined {
    if (c.at === "bottom") return this.bottomMetrics[c.metric];
    if (c.at === "max") return this.repMax[c.metric];
    return this.repMin[c.metric];
  }
  private checkApplies(c: FormCheck): boolean {
    const want = c.view ?? this.ex.view;
    if (want === "either") return true;
    return this.filmedView === "either" || this.filmedView === want;
  }
  private evalChecks(metricsOverride?: { agg: (c: FormCheck) => number | undefined }): FaultHit[] {
    const hits: FaultHit[] = [];
    for (const c of this.ex.formChecks) {
      if (!this.checkApplies(c)) continue;
      const val = metricsOverride ? metricsOverride.agg(c) : this.aggForCheck(c);
      if (val == null) continue;
      if (cmp(val, c.op, c.value)) {
        hits.push({ code: c.code, fault: c.fault, cue: c.cue, severity: c.severity, reliability: c.reliability ?? "ok" });
      }
    }
    return hits;
  }

  /** Live form flags for the current frame (drives real-time cues). */
  private liveFaults(): FaultHit[] {
    return this.evalChecks({ agg: (c) => this.last[c.metric] });
  }

  snapshot(): RepFormSnapshot {
    return {
      reps: this.reps.length,
      phase: this.phase,
      primary: this.primary != null ? Math.round(this.primary) : null,
      liveFaults: this.liveFaults(),
      quality: this.visN ? +(this.visSum / this.visN).toFixed(2) : 0,
      lastRep: this.reps.length ? this.reps[this.reps.length - 1] : null,
    };
  }

  report(): SetReport {
    const byCode = new Map<string, SetReport["faults"][number]>();
    for (const r of this.reps) {
      for (const f of r.faults) {
        const e = byCode.get(f.code);
        if (e) e.reps += 1;
        else byCode.set(f.code, { code: f.code, fault: f.fault, cue: f.cue, severity: f.severity, reliability: f.reliability, reps: 1 });
      }
    }
    const n = this.reps.length;
    let e = 0, b = 0, c = 0;
    for (const r of this.reps) { e += r.tempo[0]; b += r.tempo[1]; c += r.tempo[2]; }
    return {
      exerciseId: this.ex.id,
      exerciseName: this.ex.name,
      reps: n,
      reps_detail: this.reps.slice(),
      faults: [...byCode.values()].sort((a, z) => z.reps - a.reps),
      avgTempo: n ? [+(e / n).toFixed(1), +(b / n).toFixed(1), +(c / n).toFixed(1)] : null,
      cleanReps: this.reps.filter((r) => r.faults.every((f) => f.severity === "info")).length,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Self-test — synthetic squat: counts reps, computes tempo, flags a   */
/* trunk-lean fault on a bad rep. (Run in dev via the App selfTest hook.)*/
/* ------------------------------------------------------------------ */
export function selfTestRepForm(): { ok: boolean; detail: string } {
  // Build a sagittal squat frame: knee at fixed point, ankle straight below,
  // hip placed so the hip–knee–ankle angle == kneeDeg; shoulders set to a given
  // trunk-lean from the hip. Both sides identical (side-pick agnostic).
  const blank = (): Landmark => ({ x: 0.5, y: 0.5, visibility: 0.95 });
  const frame = (kneeDeg: number, leanDeg: number): Landmarks => {
    const lm: Landmarks = Array.from({ length: 33 }, blank);
    const K = { x: 0.5, y: 0.65 };
    const A = { x: 0.5, y: 0.85 }; // knee→ankle points straight down
    const aRad = (kneeDeg * Math.PI) / 180;
    const H = { x: K.x + 0.2 * Math.sin(aRad), y: K.y + 0.2 * Math.cos(aRad) }; // hip
    const lRad = (leanDeg * Math.PI) / 180;
    const S = { x: H.x + 0.25 * Math.sin(lRad), y: H.y - 0.25 * Math.cos(lRad) }; // shoulder above hip, leaned
    const set = (i: number, p: { x: number; y: number }) => { lm[i] = { x: p.x, y: p.y, visibility: 0.95 }; };
    set(LM.L_HIP, H); set(LM.R_HIP, H);
    set(LM.L_KNEE, K); set(LM.R_KNEE, K);
    set(LM.L_ANKLE, A); set(LM.R_ANKLE, A);
    set(LM.L_SHOULDER, S); set(LM.R_SHOULDER, S);
    return lm;
  };

  const ex: Exercise = {
    id: "test_squat", name: "Test Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    formChecks: [{ code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 55, fault: "excessive forward lean", cue: "Chest up", severity: "warn" }],
  };
  const an = new RepFormAnalyzer(ex);
  let t = 0;
  const step = (kneeDeg: number, lean: number) => { an.push(t, frame(kneeDeg, lean)); t += 50; };
  // helper: one rep = top→bottom→top over several frames
  const rep = (bottomKnee: number, lean: number) => {
    for (const k of [170, 150, 120, 100, bottomKnee, bottomKnee, 100, 120, 150, 170]) step(k, lean);
  };
  rep(85, 10); // clean
  rep(85, 10); // clean
  rep(85, 70); // excessive lean → fault
  // partial: dips to 120° (never reaches bottomEnter 95) then back up → must NOT count
  for (const k of [170, 145, 120, 145, 170]) step(k, 10);
  const rpt = an.report();

  const checks: string[] = [];
  let allOk = true;
  const expect = (c: boolean, m: string) => { if (!c) { allOk = false; checks.push("FAIL " + m); } };
  expect(rpt.reps === 3, `reps=${rpt.reps} (want 3)`);
  expect(rpt.faults.some((f) => f.code === "trunk_lean" && f.reps === 1), `trunk_lean fault on 1 rep (got ${JSON.stringify(rpt.faults.map((f) => [f.code, f.reps]))})`);
  expect(!!rpt.avgTempo && rpt.avgTempo[0] > 0 && rpt.avgTempo[2] > 0, `tempo ecc/con > 0 (${JSON.stringify(rpt.avgTempo)})`);
  return { ok: allOk, detail: allOk ? `3 reps, tempo ${JSON.stringify(rpt.avgTempo)}, 1 lean fault` : checks.join("; ") };
}
