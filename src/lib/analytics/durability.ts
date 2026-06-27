/**
 * Durability — ported from MBP-beta analysis.py.
 *
 *  - pwlfOneKnot: closed-form 1-knot continuous piecewise-linear fit (hinge basis,
 *    prefix-sum suffix moments, 3×3 normal-equations solve) — the engine behind:
 *  - pointOfNoReturn: HR-lag-compensated EF trajectory → the moment drift starts
 *    ACCELERATING (the durability "bend"), with a MAD-z-score confidence.
 *  - autoWarmupEnd: self-calibrated warm-up-end detection (speed+HR gates).
 *  - efDegradationRate: OLS %/hr decline of EF over the session + R².
 */

import type { SeriesPoint } from "../../types";
import { dts } from "./util";

/* --------------------------- 3×3 linear solver --------------------------- */
function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
function solve3(M: number[][], v: number[]): number[] | null {
  const det = det3(M);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const col = (j: number) => M.map((row, i) => row.map((val, k) => (k === j ? v[i] : val)));
  return [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det];
}

export interface PwlfStats {
  bestK: number;
  sse: number;
  sseLinear: number;
  improve: number;
  slope1: number;
  slope2: number;
  x0: number;
}

/** 1-knot continuous piecewise-linear fit: y = a + b1·x + b2·max(0, x−x0). */
export function pwlfOneKnot(xIn: number[], yIn: number[], minSeg = 300, maxCandidates = 2500): PwlfStats | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < xIn.length; i++) if (Number.isFinite(xIn[i]) && Number.isFinite(yIn[i])) {
    xs.push(xIn[i]);
    ys.push(yIn[i]);
  }
  const n = xs.length;
  if (n < 2 * minSeg + 20) return null;
  const x0v = xs[0];
  for (let i = 0; i < n; i++) xs[i] -= x0v;

  const sx = new Array(n + 1).fill(0);
  const sy = new Array(n + 1).fill(0);
  const sxx = new Array(n + 1).fill(0);
  const sxy = new Array(n + 1).fill(0);
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sx[i + 1] = sx[i] + xs[i];
    sy[i + 1] = sy[i] + ys[i];
    sxx[i + 1] = sxx[i] + xs[i] * xs[i];
    sxy[i + 1] = sxy[i] + xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const S1 = n;
  const Sx = sx[n];
  const Sy = sy[n];
  const Sxx = sxx[n];
  const Sxy = sxy[n];

  // single-line SSE for the improvement score
  let sseLinear = NaN;
  const xbar = Sx / S1;
  const ybar = Sy / S1;
  let varx = 0;
  let covxy = 0;
  for (let i = 0; i < n; i++) {
    varx += (xs[i] - xbar) ** 2;
    covxy += (xs[i] - xbar) * (ys[i] - ybar);
  }
  if (varx > 1e-12) {
    const bLin = covxy / varx;
    const aLin = ybar - bLin * xbar;
    sseLinear = syy - 2 * (aLin * Sy + bLin * Sxy) + (aLin * aLin * S1 + 2 * aLin * bLin * Sx + bLin * bLin * Sxx);
  }

  const lo = Math.max(1, minSeg);
  const hi = n - minSeg - 2;
  if (hi <= lo) return null;
  const span = hi - lo + 1;
  const step = Math.max(1, Math.ceil(span / maxCandidates));

  let bestK = -1;
  let bestSse = Infinity;
  let bestBeta: number[] | null = null;
  const evalK = (k: number) => {
    const x0 = xs[k];
    const m = n - (k + 1);
    if (m < minSeg) return;
    const sxA = sx[n] - sx[k + 1];
    const syA = sy[n] - sy[k + 1];
    const sxxA = sxx[n] - sxx[k + 1];
    const sxyA = sxy[n] - sxy[k + 1];
    const Sz = sxA - x0 * m;
    const Szz = sxxA - 2 * x0 * sxA + x0 * x0 * m;
    const Sxz = sxxA - x0 * sxA;
    const Szy = sxyA - x0 * syA;
    const M = [
      [S1, Sx, Sz],
      [Sx, Sxx, Sxz],
      [Sz, Sxz, Szz],
    ];
    const v = [Sy, Sxy, Szy];
    const beta = solve3(M, v);
    if (!beta) return;
    // sse = syy - 2 β·v + β·(M β)
    const Mb = M.map((row) => row[0] * beta[0] + row[1] * beta[1] + row[2] * beta[2]);
    const sse = syy - 2 * (beta[0] * v[0] + beta[1] * v[1] + beta[2] * v[2]) + (beta[0] * Mb[0] + beta[1] * Mb[1] + beta[2] * Mb[2]);
    if (Number.isFinite(sse) && sse < bestSse) {
      bestSse = sse;
      bestK = k;
      bestBeta = beta;
    }
  };
  for (let k = lo; k <= hi; k += step) evalK(k);
  if (bestK < 0 || !bestBeta) return null;
  const r = Math.max(20, step * 3);
  for (let k = Math.max(lo, bestK - r); k <= Math.min(hi, bestK + r); k++) evalK(k);
  if (bestK < 0 || !bestBeta) return null;

  const b = bestBeta as number[];
  const improve = Number.isFinite(sseLinear) && sseLinear > 1e-9 ? (sseLinear - bestSse) / sseLinear : NaN;
  return { bestK, sse: bestSse, sseLinear, improve, slope1: b[1], slope2: b[1] + b[2], x0: xs[bestK] };
}

/* ------------------- centered rolling median / mean ---------------------- */
function rollMedian(a: (number | null)[], win: number): (number | null)[] {
  const h = Math.floor(win / 2);
  return a.map((_, i) => {
    const w: number[] = [];
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length && a[j] != null && Number.isFinite(a[j] as number)) w.push(a[j] as number);
    if (!w.length) return null;
    w.sort((x, y) => x - y);
    return w[Math.floor(w.length / 2)];
  });
}
function rollMean(a: (number | null)[], win: number, minP: number): (number | null)[] {
  const h = Math.floor(win / 2);
  return a.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < a.length && a[j] != null && Number.isFinite(a[j] as number)) {
      s += a[j] as number;
      c++;
    }
    return c >= minP ? s / c : null;
  });
}

export interface PonrResult {
  breakSec: number; // moving-time seconds into the (post-warmup) effort
  confidence: "low" | "medium" | "high";
}

/**
 * Point of no return: the moment the EF(t) trajectory bends into a steeper
 * decline. Needs speed (no power channel in RoxLive). Returns null if not
 * detectable (too short, no acceleration, etc.).
 */
export function pointOfNoReturn(pts: SeriesPoint[], opts: { minConfirmSec?: number; lagSec?: number; efSmoothSec?: number } = {}): PonrResult | null {
  if (pts.length < 120) return null;
  const minConfirm = opts.minConfirmSec ?? 600;
  const lagSec = opts.lagSec ?? 30;
  const efSmoothSec = opts.efSmoothSec ?? 60;
  const d = dts(pts);
  const step = Math.min(5, Math.max(0.5, d[Math.floor(d.length / 2)] || 1));

  // Median over RAW hr/out (NaN only for non-finite / out-of-physiologic-range —
  // NOT for non-moving), then apply the moving mask to EF afterward. This matches
  // MBP's order; gating before the median would corrupt the window at every
  // run↔station transition and shift the detected breakpoint.
  const hrRaw: (number | null)[] = pts.map((p) => (p.hr != null && Number.isFinite(p.hr) && (p.hr as number) >= 30 && (p.hr as number) <= 230 ? (p.hr as number) : null));
  const outRaw: (number | null)[] = pts.map((p) => (p.speedMps != null && Number.isFinite(p.speedMps) && (p.speedMps as number) >= 0 ? (p.speedMps as number) : null));
  const moving: boolean[] = pts.map((p) => p.speedMps != null && (p.speedMps as number) > 0.8);
  if (moving.filter(Boolean).length < 120) return null;

  const w = Math.max(1, Math.round(5 / step));
  const hrM = rollMedian(hrRaw, w);
  const outM = rollMedian(outRaw, w);
  const lag = Math.max(0, Math.round(lagSec / step));
  // EF = out / hr_shifted(-lag), only where the sample is moving + valid.
  const ef: (number | null)[] = pts.map((_, i) => {
    if (!moving[i]) return null;
    const o = outM[i];
    const hs = hrM[i + lag];
    return o != null && o > 0 && hs != null && hs > 0 ? o / hs : null;
  });
  const smW = Math.max(3, Math.round(efSmoothSec / step));
  const efS = rollMean(ef, smW, Math.max(3, Math.floor(smW / 3)));

  // longest contiguous finite block
  const y: number[] = [];
  let run: number[] = [];
  let best: number[] = [];
  for (const v of efS) {
    if (v != null && Number.isFinite(v)) run.push(v);
    else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  for (const v of best) y.push(v);
  const need = Math.round((2 * minConfirm) / step) + 60;
  if (y.length < need) return null;

  const x = y.map((_, i) => i * step);
  const fit = pwlfOneKnot(x, y, Math.max(120, Math.round(minConfirm / step)), 2500);
  if (!fit) return null;
  const { slope1: s1, slope2: s2, x0, improve } = fit;
  if (!(s2 - s1 < 0 && s2 < s1)) return null; // must accelerate (steeper decline)

  const pos = Math.min(y.length - 1, Math.max(0, Math.round(x0 / step)));
  // confidence: baseline EF (after ~3min), MAD sigma, persistence, z-score
  const skip = Math.round(180 / step);
  const baseLen = Math.round(Math.min(1800, Math.max(600, 0.25 * y.length * step)) / step);
  const yBase = y.slice(skip, Math.min(y.length, skip + Math.max(60, baseLen))).filter(Number.isFinite);
  const med = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const ef0 = med(yBase);
  const mad = yBase.length ? med(yBase.map((v) => Math.abs(v - ef0))) : NaN;
  let sigma = Number.isFinite(mad) && mad > 0 ? 1.4826 * mad : NaN;
  if (!(sigma > 0)) {
    const m = yBase.reduce((a, b) => a + b, 0) / (yBase.length || 1);
    sigma = Math.sqrt(yBase.reduce((a, b) => a + (b - m) ** 2, 0) / (yBase.length || 1)) || 1e-12;
  }
  const preWin = Math.max(60, Math.round(300 / step));
  const postWin = Math.max(60, Math.round(minConfirm / step));
  const yPre = y.slice(Math.max(0, pos - preWin), pos);
  const yPost = y.slice(pos, Math.min(y.length, pos + postWin));
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const preMu = mean(yPre);
  const postMu = mean(yPost);
  const z = Number.isFinite(ef0) && Number.isFinite(postMu) ? (ef0 - postMu) / (sigma + 1e-12) : NaN;
  const persist = Number.isFinite(preMu) && Number.isFinite(postMu) && postMu < preMu - 0.5 * sigma && postMu < ef0 - 0.25 * sigma;
  const s1n = ef0 ? s1 / ef0 : NaN;
  const s2n = ef0 ? s2 / ef0 : NaN;
  const dnPerMin = (s2n - s1n) * 60;
  const s2nPerMin = s2n * 60;

  let conf: "low" | "medium" | "high" = "low";
  if (persist && improve >= 0.25 && z >= 2.5 && dnPerMin <= -0.001 && s2nPerMin <= -0.001) conf = "high";
  else if (persist && improve >= 0.12 && z >= 1.5 && dnPerMin <= -0.0005 && s2nPerMin <= -0.0005) conf = "medium";
  else return null; // not confident enough to report

  return { breakSec: Math.max(0, Math.round(x0)), confidence: conf };
}

/** OLS %/hr decline of EF over the session + R² (durability decay rate). */
export function efDegradationRate(pts: SeriesPoint[]): { pctPerHr: number; r2: number } | null {
  // 1-min bins of EF (speed*3.6 / hr, or 1000/hr proxy)
  const d = dts(pts);
  let tAcc = 0;
  const binEf = new Map<number, { sOut: number; sHr: number; w: number }>();
  const hasSpeed = pts.some((p) => p.speedMps != null && (p.speedMps as number) > 0);
  for (let i = 0; i < pts.length; i++) {
    tAcc += d[i];
    const min = Math.floor(tAcc / 60);
    const hr = pts[i].hr;
    if (hr == null || !Number.isFinite(hr) || hr <= 0) continue;
    const out = hasSpeed ? (pts[i].speedMps != null && (pts[i].speedMps as number) > 0 ? (pts[i].speedMps as number) * 3.6 : null) : 1000 / hr;
    if (out == null) continue;
    const b = binEf.get(min) ?? { sOut: 0, sHr: 0, w: 0 };
    b.sOut += out * d[i];
    b.sHr += hr * d[i];
    b.w += d[i];
    binEf.set(min, b);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [min, b] of [...binEf.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.w < 20) continue;
    const ef = hasSpeed ? b.sOut / b.sHr : b.sOut / b.w; // proxy already per-sample 1000/hr
    if (Number.isFinite(ef) && ef > 0) {
      xs.push(min);
      ys.push(ef);
    }
  }
  if (xs.length < 5) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx <= 0 || my === 0) return null;
  const slope = sxy / sxx; // EF per minute
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const pctPerHr = (slope * 60) / my * 100;
  return { pctPerHr: +pctPerHr.toFixed(1), r2: +r2.toFixed(2) };
}

/** Self-calibrated warm-up-end detection (speed + HR gates + stability). */
export function autoWarmupEnd(pts: SeriesPoint[]): number {
  const d = dts(pts);
  const totalSec = d.reduce((a, b) => a + b, 0);
  if (totalSec < 20 * 60) return Math.min(300, Math.round(0.15 * totalSec)); // short: light trim
  // minute bins
  let tAcc = 0;
  const minHr: number[] = [];
  const minSpd: number[] = [];
  const accH: number[] = [];
  const accHw: number[] = [];
  const accS: number[] = [];
  const accSw: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    tAcc += d[i];
    const m = Math.floor((tAcc - d[i]) / 60);
    while (accH.length <= m) {
      accH.push(0);
      accHw.push(0);
      accS.push(0);
      accSw.push(0);
    }
    const hr = pts[i].hr;
    if (hr != null && Number.isFinite(hr) && hr >= 25 && hr <= 240) {
      accH[m] += hr * d[i];
      accHw[m] += d[i];
    }
    const sp = pts[i].speedMps;
    if (sp != null && Number.isFinite(sp) && sp >= 0 && sp <= 15) {
      accS[m] += sp * d[i];
      accSw[m] += d[i];
    }
  }
  for (let m = 0; m < accH.length; m++) {
    minHr.push(accHw[m] > 0 ? accH[m] / accHw[m] : NaN);
    minSpd.push(accSw[m] > 0 ? accS[m] / accSw[m] : NaN);
  }
  const hasSpeed = minSpd.filter((v) => Number.isFinite(v) && v > 0).length > 3;
  const spdRef = hasSpeed
    ? (() => {
        const v = minSpd.slice(2).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : NaN;
      })()
    : NaN;
  const steadyHrArr = minHr.slice(10, 20).filter(Number.isFinite);
  const steadyHr = steadyHrArr.length ? steadyHrArr.reduce((a, b) => a + b, 0) / steadyHrArr.length : NaN;
  if (!Number.isFinite(steadyHr)) return 900;
  const spdGate = hasSpeed ? 0.85 * spdRef : -Infinity;
  const hrGate = 0.9 * steadyHr;
  let passStreak = 0;
  for (let m = 1; m < minHr.length; m++) {
    const stable = Number.isFinite(minHr[m]) && Number.isFinite(minHr[m - 1]) && Math.abs(minHr[m] - minHr[m - 1]) < 3;
    const hrOk = Number.isFinite(minHr[m]) && minHr[m] >= hrGate;
    const spdOk = !hasSpeed || (Number.isFinite(minSpd[m]) && minSpd[m] >= spdGate);
    if (stable && hrOk && spdOk) {
      passStreak++;
      if (passStreak >= 2) return Math.max(180, (m - 1) * 60);
    } else passStreak = 0;
  }
  return Math.min(900, Math.round(totalSec / 3));
}
