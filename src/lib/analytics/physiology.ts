/**
 * Physiology extras — ported from MBP-beta analysis.py, but anchored on RoxLive's
 * own signals where it has better ones (DFA-α1 for LT1, live RSA respiration).
 *
 *  - LT1 polarization: % time easy (below LT1) vs hard. LT1 HR is taken from the
 *    α1≈0.75 crossing when α1 data exists (RoxLive's edge), else 0.775·maxHR.
 *  - Respiratory drift + breath/HR ratio (ventilatory efficiency) from brpm.
 *  - Stride-length fatigue: late-session stride shortening (auto-corrects single-leg cadence).
 */

import type { SeriesPoint } from "../../types";
import { dts, wmean, isNum, type Prof } from "./util";

export interface Lt1Result {
  lt1Hr: number;
  pctBelow: number;
  pctAbove: number;
  source: "alpha1" | "maxhr";
}

/** Estimate LT1 HR and the easy/hard time split. */
export function lt1Polarization(pts: SeriesPoint[], prof: Prof): Lt1Result | null {
  if (!isNum(prof.maxHr) || prof.maxHr <= 0) return null;
  // Prefer an α1-anchored LT1: median HR over samples where α1 sits in the LT1 band.
  const band = pts.filter((p) => p.alpha1 != null && (p.alpha1 as number) >= 0.7 && (p.alpha1 as number) <= 0.8 && p.hr != null && (p.hr as number) > 0);
  let lt1Hr: number;
  let source: "alpha1" | "maxhr";
  if (band.length >= 10) {
    const hrs = band.map((p) => p.hr as number).sort((a, b) => a - b);
    lt1Hr = hrs[Math.floor(hrs.length / 2)];
    source = "alpha1";
  } else {
    lt1Hr = 0.775 * prof.maxHr;
    source = "maxhr";
  }
  const d = dts(pts);
  let below = 0;
  let above = 0;
  for (let i = 0; i < pts.length; i++) {
    const hr = pts[i].hr;
    if (hr == null || !Number.isFinite(hr) || hr <= 0) continue;
    if (hr < lt1Hr) below += d[i];
    else above += d[i];
  }
  const tot = below + above;
  if (tot <= 0) return null;
  return { lt1Hr: Math.round(lt1Hr), pctBelow: +((below / tot) * 100).toFixed(0), pctAbove: +((above / tot) * 100).toFixed(0), source };
}

export interface RespResult {
  avgBrpm: number;
  peakBrpm: number;
  driftPct: number | null; // 2nd-half vs 1st-half
  rrHrRatio: number | null; // breaths per beat ×100 — ventilatory efficiency proxy
  nearVt2: boolean;
}

/** Respiratory drift + breath/HR ratio from the brpm series. */
export function respiratory(pts: SeriesPoint[]): RespResult | null {
  const valid = pts.filter((p) => p.brpm != null && Number.isFinite(p.brpm) && (p.brpm as number) > 0 && (p.brpm as number) < 80);
  if (valid.length < 20) return null;
  const d = dts(valid);
  const avg = wmean(valid, d, (p) => p.brpm);
  if (!isNum(avg)) return null;
  const peak = Math.max(...valid.map((p) => p.brpm as number));
  const mid = Math.floor(valid.length / 2);
  let drift: number | null = null;
  if (mid >= 10) {
    const h1 = valid.slice(0, mid);
    const h2 = valid.slice(mid);
    const m1 = wmean(h1, dts(h1), (p) => p.brpm);
    const m2 = wmean(h2, dts(h2), (p) => p.brpm);
    if (isNum(m1) && m1 > 0 && isNum(m2)) drift = +(((m2 - m1) / m1) * 100).toFixed(1);
  }
  // breath/HR ratio over samples with both
  let sR = 0;
  let wR = 0;
  for (let i = 0; i < valid.length; i++) {
    const hr = valid[i].hr;
    if (hr != null && Number.isFinite(hr) && hr > 0) {
      sR += ((valid[i].brpm as number) / hr) * d[i];
      wR += d[i];
    }
  }
  const ratio = wR > 0 ? +((sR / wR) * 100).toFixed(2) : null;
  return { avgBrpm: +avg.toFixed(0), peakBrpm: Math.round(peak), driftPct: drift, rrHrRatio: ratio, nearVt2: avg > 30 };
}

export interface StrideResult {
  avgStrideM: number;
  avgCadenceSpm: number;
  changePct: number | null; // 2nd vs 1st half; negative = shortening (fatigue)
}

/** Stride length (m/step) + late-session shortening. */
export function strideFatigue(pts: SeriesPoint[]): StrideResult | null {
  const valid = pts.filter(
    (p) => p.cadence != null && (p.cadence as number) > 0 && p.speedMps != null && (p.speedMps as number) > 0
  );
  if (valid.length < 30) return null;
  const d = dts(valid);
  const rawCad = wmean(valid, d, (p) => p.cadence);
  const spd = wmean(valid, d, (p) => p.speedMps);
  if (!isNum(rawCad) || !isNum(spd) || rawCad <= 0) return null;
  // Normalize to total steps/min: footpods/Garmin report single-leg (~80-95 spm),
  // pose-derived cadence is already total (~150-190). A median below ~120 ⇒ single-leg.
  const mult = rawCad < 120 ? 2 : 1;
  const cad = rawCad * mult;
  const stride = spd / (cad / 60);
  const half = (a: SeriesPoint[]) => {
    const c = wmean(a, dts(a), (p) => p.cadence) * mult;
    const s = wmean(a, dts(a), (p) => p.speedMps);
    return isNum(c) && c > 0 && isNum(s) ? s / (c / 60) : NaN;
  };
  const mid = Math.floor(valid.length / 2);
  let change: number | null = null;
  if (mid >= 15) {
    const st1 = half(valid.slice(0, mid));
    const st2 = half(valid.slice(mid));
    if (isNum(st1) && st1 > 0 && isNum(st2)) change = +(((st2 - st1) / st1) * 100).toFixed(1);
  }
  return { avgStrideM: +stride.toFixed(2), avgCadenceSpm: Math.round(cad), changePct: change };
}
