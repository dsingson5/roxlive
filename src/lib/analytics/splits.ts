/**
 * Per-km split analysis — ported from MBP-beta analysis.py compute_split_analysis.
 * Integrates distance from the speed series, computes per-km pace, pace CV
 * (consistency), negative/positive split, and fastest/slowest km.
 */

import type { SeriesPoint } from "../../types";
import { dts, isNum } from "./util";

export interface KmSplit {
  km: number;
  paceSecPerKm: number;
  avgHr: number | null;
}

export interface SplitAnalysis {
  kmSplits: KmSplit[];
  numSplits: number;
  isNegativeSplit: boolean;
  splitDiffSecPerKm: number; // +ve = slowed in 2nd half
  paceCvPct: number;
  fastestKm: number;
  slowestKm: number;
  paceSpreadSec: number;
  consistency: string;
}

function cvLabel(cv: number): string {
  if (cv < 3) return "very even";
  if (cv < 5) return "consistent";
  if (cv < 8) return "moderate variability";
  return "high variability — pacing needs work";
}

export function splitAnalysis(pts: SeriesPoint[]): SplitAnalysis | null {
  if (pts.length < 30) return null;
  const d = dts(pts);
  // cumulative distance (km) and a parallel elapsed axis
  const distKm: number[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const sp = pts[i].speedMps;
    if (sp != null && Number.isFinite(sp) && sp > 0) acc += (sp * d[i]) / 1000;
    distKm.push(acc);
  }
  const totalKm = Math.floor(distKm[distKm.length - 1]);
  if (totalKm < 2) return null;

  const splits: KmSplit[] = [];
  for (let km = 1; km <= totalKm; km++) {
    const idx: number[] = [];
    for (let i = 0; i < pts.length; i++) if (distKm[i] >= km - 1 && distKm[i] < km) idx.push(i);
    if (idx.length < 5) continue;
    let sSpeed = 0;
    let wSpeed = 0;
    let sHr = 0;
    let wHr = 0;
    for (const i of idx) {
      const sp = pts[i].speedMps;
      if (sp != null && sp > 0) {
        sSpeed += sp * d[i];
        wSpeed += d[i];
      }
      const hr = pts[i].hr;
      if (hr != null && Number.isFinite(hr) && hr > 0) {
        sHr += hr * d[i];
        wHr += d[i];
      }
    }
    const avgSpeed = wSpeed > 0 ? sSpeed / wSpeed : 0;
    if (avgSpeed <= 0) continue;
    splits.push({ km, paceSecPerKm: 1000 / avgSpeed, avgHr: wHr > 0 ? Math.round(sHr / wHr) : null });
  }
  const paces = splits.map((s) => s.paceSecPerKm).filter(isNum);
  if (paces.length < 2) return null;

  const mid = Math.floor(paces.length / 2);
  const first = paces.slice(0, mid);
  const second = paces.slice(mid);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const avgFirst = mean(first);
  const avgSecond = mean(second);
  const splitDiff = avgSecond - avgFirst;
  const pmean = mean(paces);
  const pstd = Math.sqrt(paces.reduce((s, p) => s + (p - pmean) ** 2, 0) / paces.length);
  const cv = pmean > 0 ? (pstd / pmean) * 100 : 0;
  let fastest = splits[0];
  let slowest = splits[0];
  for (const s of splits) {
    if (s.paceSecPerKm < fastest.paceSecPerKm) fastest = s;
    if (s.paceSecPerKm > slowest.paceSecPerKm) slowest = s;
  }

  return {
    kmSplits: splits,
    numSplits: splits.length,
    isNegativeSplit: splitDiff < 0,
    splitDiffSecPerKm: +splitDiff.toFixed(1),
    paceCvPct: +cv.toFixed(1),
    fastestKm: fastest.km,
    slowestKm: slowest.km,
    paceSpreadSec: +(slowest.paceSecPerKm - fastest.paceSecPerKm).toFixed(1),
    consistency: cvLabel(cv),
  };
}
