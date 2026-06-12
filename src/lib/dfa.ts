/**
 * DFA-alpha-1 — short-term Detrended Fluctuation Analysis scaling exponent.
 *
 * Per the PDF this is the single most valuable real-time internal-load metric:
 *   alpha1 ~ 1.0  -> low intensity, below the first lactate/ventilatory threshold (LT1/VT1)
 *   alpha1 ~ 0.75 -> commonly used aerobic-threshold (LT1) marker
 *   alpha1 ~ 0.5  -> commonly used anaerobic-threshold (LT2) marker; uncorrelated dynamics
 *   alpha1 < 0.5  -> above threshold, anti-correlated dynamics, heavy/severe domain
 *
 * Algorithm (Peng et al. 1995), short-term window n = 4..16 beats:
 *   1. Integrate the mean-centred R-R series:  y(k) = Σ_{i<=k} (rr_i − mean)
 *   2. For each box size n, split y into ⌊N/n⌋ non-overlapping boxes (from both
 *      ends, to use all data), least-squares detrend each box, take RMS residual.
 *      F(n) = sqrt( mean over boxes of residual variance )
 *   3. alpha1 = slope of the line fitting log F(n) vs log n.
 *
 * Validation anchors (used by the dev self-test):
 *   white noise        -> alpha ≈ 0.5
 *   1/f (pink) noise    -> alpha ≈ 1.0
 *   Brownian (integral) -> alpha ≈ 1.5
 */

import { cleanRR } from "./artifact";
import type { DfaResult } from "../types";

const BOX_SIZES: number[] = (() => {
  const out: number[] = [];
  for (let n = 4; n <= 16; n++) out.push(n);
  return out;
})();

/** Least-squares slope of y on x for equal-length arrays. */
function slope(x: number[], y: number[]): number {
  const n = x.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return NaN;
  return (n * sxy - sx * sy) / denom;
}

/** RMS of detrended residuals within a single box [start, start+n). */
function boxRms(y: number[], start: number, n: number): number {
  // x = 0..n-1
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    const xi = i;
    const yi = y[start + i];
    sx += xi;
    sy += yi;
    sxx += xi * xi;
    sxy += xi * yi;
  }
  const denom = n * sxx - sx * sx;
  const b = denom === 0 ? 0 : (n * sxy - sx * sy) / denom; // slope
  const a = (sy - b * sx) / n; // intercept
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const fit = a + b * i;
    const r = y[start + i] - fit;
    ss += r * r;
  }
  return ss / n; // variance (we sqrt after averaging across boxes)
}

/** F(n): fluctuation at box size n using non-overlapping boxes from both ends. */
function fluctuation(y: number[], n: number): number | null {
  const N = y.length;
  const boxes = Math.floor(N / n);
  if (boxes < 1) return null;
  let acc = 0;
  let count = 0;
  // Forward pass
  for (let b = 0; b < boxes; b++) {
    acc += boxRms(y, b * n, n);
    count++;
  }
  // Backward pass (covers the tail that forward boxes miss)
  const offset = N - boxes * n;
  if (offset > 0) {
    for (let b = 0; b < boxes; b++) {
      acc += boxRms(y, offset + b * n, n);
      count++;
    }
  }
  if (count === 0) return null;
  return Math.sqrt(acc / count);
}

/**
 * Compute alpha-1 from a raw R-R window (ms). Cleans artifacts first.
 * Returns a full DfaResult including artifact % and a reliability flag.
 */
export function computeDFA(rrWindow: number[]): DfaResult {
  const { clean, artifactPct } = cleanRR(rrWindow);
  const beats = clean.length;

  const result: DfaResult = {
    alpha1: null,
    artifactPct: artifactPct * 100,
    beats,
    reliable: false,
  };

  // Need enough beats so the largest box (16) has at least ~4 boxes.
  if (beats < 64) return result;

  // 1. Integrate mean-centred series.
  let m = 0;
  for (const v of clean) m += v;
  m /= beats;
  const y = new Array<number>(beats);
  let run = 0;
  for (let i = 0; i < beats; i++) {
    run += clean[i] - m;
    y[i] = run;
  }

  // 2. F(n) across box sizes.
  const logN: number[] = [];
  const logF: number[] = [];
  for (const n of BOX_SIZES) {
    const f = fluctuation(y, n);
    if (f !== null && f > 0) {
      logN.push(Math.log(n));
      logF.push(Math.log(f));
    }
  }
  if (logN.length < 4) return result;

  // 3. Slope = alpha1.
  const a = slope(logN, logF);
  if (!Number.isFinite(a)) return result;

  result.alpha1 = clamp(a, 0, 2);
  result.reliable = beats >= 64 && artifactPct <= 0.15;
  return result;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Dev-only numeric validation. White noise → α≈0.5, 1/f (pink) → α≈1.0,
 * Brownian → α≈1.5. Logs results; returns pass/fail for the suite.
 */
export function selfTestDFA(): boolean {
  const N = 2048;
  // White
  const white: number[] = [];
  for (let i = 0; i < N; i++) white.push(800 + 60 * randn());
  // Brownian = cumulative sum of white increments
  const brown: number[] = [];
  let acc = 800;
  for (let i = 0; i < N; i++) {
    acc += 8 * randn();
    brown.push(acc);
  }
  // Pink (1/f) via summed octaves of smoothed noise
  const pink = makePink(N).map((v) => 800 + 50 * v);

  const aw = computeDFA(white).alpha1;
  const ap = computeDFA(pink).alpha1;
  const ab = computeDFA(brown).alpha1;

  const ok =
    aw !== null && Math.abs(aw - 0.5) < 0.18 &&
    ap !== null && Math.abs(ap - 1.0) < 0.25 &&
    ab !== null && ab > 1.2;

  // eslint-disable-next-line no-console
  console.log(
    `[DFA self-test] white α=${aw?.toFixed(2)} (~0.5), pink α=${ap?.toFixed(2)} (~1.0), brown α=${ab?.toFixed(2)} (~1.5) → ${ok ? "PASS" : "CHECK"}`
  );
  return ok;
}

function randn(): number {
  let u = 0,
    v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makePink(n: number): number[] {
  // Voss-McCartney-ish: sum of progressively-slower random holds.
  const octaves = 8;
  const out = new Array(n).fill(0);
  const hold = new Array(octaves).fill(0).map(() => randn());
  for (let i = 0; i < n; i++) {
    for (let o = 0; o < octaves; o++) {
      if (i % (1 << o) === 0) hold[o] = randn();
      out[i] += hold[o];
    }
    out[i] /= octaves;
  }
  return out;
}

/** Map alpha-1 to a coaching intensity band + colour token. */
export function alphaBand(a: number | null): {
  label: string;
  domain: string;
  color: string;
} {
  if (a === null) return { label: "—", domain: "warming up", color: "var(--color-ink-faint)" };
  if (a >= 0.85) return { label: "Easy", domain: "below LT1 · aerobic base", color: "var(--color-z2)" };
  if (a >= 0.75) return { label: "LT1", domain: "aerobic threshold", color: "var(--color-z3)" };
  if (a >= 0.55) return { label: "Tempo", domain: "between thresholds", color: "var(--color-z4)" };
  if (a >= 0.45) return { label: "LT2", domain: "anaerobic threshold", color: "var(--color-amber)" };
  return { label: "Severe", domain: "above LT2 · anti-correlated", color: "var(--color-z5)" };
}
