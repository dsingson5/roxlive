/**
 * Breathing rate from R-R intervals via Respiratory Sinus Arrhythmia (RSA).
 *
 * The PDF notes respiration can be "derived from R-R (HeartPy-style)" rather
 * than requiring the on-watch respiration field. Method:
 *   1. Build a beat-time tachogram (cumulative R-R -> time, value = R-R ms).
 *   2. Resample onto a uniform 4 Hz grid by linear interpolation.
 *   3. Linear-detrend.
 *   4. Evaluate spectral power directly (Goertzel-style DFT) across the
 *      respiratory band 0.13–0.70 Hz (≈ 8–42 breaths/min — wide enough for
 *      hard HYROX efforts). Peak frequency -> breaths/min.
 *   Confidence = peak-band power / total-band power (0..1).
 */

import { cleanRR } from "./artifact";
import type { RespirationResult } from "../types";

const FS = 4; // Hz resample rate
const F_LO = 0.13; // ~8 brpm
const F_HI = 0.7; // ~42 brpm
const F_STEPS = 80;

export function computeRespiration(rrWindow: number[]): RespirationResult {
  const { clean } = cleanRR(rrWindow);
  if (clean.length < 20) return { brpm: null, confidence: 0 };

  // 1. Beat times (s) at the *end* of each interval.
  const tBeat: number[] = [];
  const vBeat: number[] = clean;
  let acc = 0;
  for (let i = 0; i < clean.length; i++) {
    acc += clean[i] / 1000;
    tBeat.push(acc);
  }
  const duration = tBeat[tBeat.length - 1] - tBeat[0];
  if (duration < 12) return { brpm: null, confidence: 0 }; // need >~12 s

  // 2. Uniform resample at FS.
  const nSamp = Math.floor(duration * FS);
  if (nSamp < 24) return { brpm: null, confidence: 0 };
  const sig = new Array<number>(nSamp);
  let j = 0;
  for (let k = 0; k < nSamp; k++) {
    const t = tBeat[0] + k / FS;
    while (j < tBeat.length - 1 && tBeat[j + 1] < t) j++;
    const t0 = tBeat[j];
    const t1 = tBeat[Math.min(j + 1, tBeat.length - 1)];
    const v0 = vBeat[j];
    const v1 = vBeat[Math.min(j + 1, vBeat.length - 1)];
    const frac = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    sig[k] = v0 + (v1 - v0) * frac;
  }

  // 3. Linear detrend.
  detrend(sig);

  // 4. Power across the respiratory band.
  let bestF = 0;
  let bestP = 0;
  let totalP = 0;
  for (let s = 0; s <= F_STEPS; s++) {
    const f = F_LO + ((F_HI - F_LO) * s) / F_STEPS;
    const p = goertzelPower(sig, f, FS);
    totalP += p;
    if (p > bestP) {
      bestP = p;
      bestF = f;
    }
  }

  if (totalP <= 0 || bestP <= 0) return { brpm: null, confidence: 0 };
  const confidence = clamp01(bestP / totalP * Math.min(F_STEPS, 24));
  const brpm = bestF * 60;
  return { brpm, confidence: clamp01(confidence) };
}

function detrend(x: number[]): void {
  const n = x.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  const b = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  for (let i = 0; i < n; i++) x[i] -= a + b * i;
}

/** Direct single-frequency power (|DFT|²/N) — robust, no bit-reversal bugs. */
function goertzelPower(x: number[], freq: number, fs: number): number {
  const n = x.length;
  const w = (2 * Math.PI * freq) / fs;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += x[i] * Math.cos(w * i);
    im += x[i] * Math.sin(w * i);
  }
  return (re * re + im * im) / n;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
