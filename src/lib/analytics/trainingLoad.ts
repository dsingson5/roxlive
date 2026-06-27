/**
 * Training load — ported from MBP-beta tss.py + analysis.py compute_trimp.
 *
 *  - Banister exponential TRIMP (per-sample HRr·0.64·e^(k·HRr), integrated /60)
 *  - Edwards 5-zone weighted TRIMP
 *  - hrTSS: TRIMP normalized to a 60-min-at-LTHR reference → 100 = a threshold hour
 *  - PMC: CTL (42 d) / ATL (7 d) EWMA over daily TSS → TSB = CTL − ATL
 *
 * RoxLive has no power meter / FTP, so the HR fallback is the load model. LTHR
 * defaults to ~88% of max HR when no lab value is available.
 */

import type { SeriesPoint } from "../../types";
import { dts, isNum, type Prof } from "./util";

export function defaultLthr(maxHr: number): number {
  return 0.88 * maxHr;
}

export interface TrainingLoad {
  tss: number; // hrTSS (100 = one hour at threshold)
  trimp: number; // Banister bTRIMP (MBP compute_trimp convention — no 0.64, all HR>0)
  trimpEdwards: number;
  lthr: number;
}

/** Banister + Edwards TRIMP and hrTSS from the HR series. */
export function trainingLoad(pts: SeriesPoint[], prof: Prof, opts: { lthr?: number } = {}): TrainingLoad | null {
  const { maxHr, restHr } = prof;
  if (!isNum(maxHr) || !isNum(restHr) || maxHr <= restHr) return null;
  const d = dts(pts);
  const k = prof.sex === "female" ? 1.67 : 1.92;
  const range = maxHr - restHr;

  // Two separate sums (they differ deliberately):
  //  - tssTrimp: hrTSS internal — band-filtered, HRr clipped to ≤1, ×0.64 (cancels
  //    against the reference, so the 0.64 is invisible in hrTSS).
  //  - banister: the DISPLAYED bTRIMP, matching MBP's compute_trimp — every HR>0,
  //    HRr floored at 0 (no upper clip), NO 0.64. (~1.56× the tss-internal sum.)
  let tssTrimp = 0;
  let banister = 0;
  let edwards = 0;
  let inBand = 0;
  const zb = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 2.0]; // Edwards 5-zone bounds (×maxHr)
  for (let i = 0; i < pts.length; i++) {
    const hr = pts[i].hr;
    if (hr == null || !Number.isFinite(hr) || hr <= 0) continue;
    const dB = Math.max(0, (hr - restHr) / range); // no upper clip
    banister += dB * Math.exp(k * dB) * (d[i] / 60);
    if (hr > restHr && hr <= maxHr) {
      inBand++;
      const hrr = Math.min(1, dB);
      tssTrimp += hrr * 0.64 * Math.exp(k * hrr) * (d[i] / 60);
      for (let z = 0; z < 5; z++) {
        if (hr >= maxHr * zb[z] && hr < maxHr * zb[z + 1]) {
          edwards += ((z + 1) * d[i]) / 60;
          break;
        }
      }
    }
  }
  if (inBand === 0) return null;

  const lthr = opts.lthr && opts.lthr > 0 ? opts.lthr : defaultLthr(maxHr);
  const lthrR = Math.min(1, Math.max(0.01, (lthr - restHr) / range));
  const refTrimp = 60 * lthrR * 0.64 * Math.exp(k * lthrR);
  const tss = refTrimp > 0 ? (tssTrimp / refTrimp) * 100 : NaN;
  if (!Number.isFinite(tss)) return null;

  return { tss: +tss.toFixed(1), trimp: +banister.toFixed(1), trimpEdwards: +edwards.toFixed(1), lthr: Math.round(lthr) };
}

/* ---------------------------- PMC (CTL/ATL/TSB) --------------------------- */

export interface PmcPoint {
  date: string; // YYYY-MM-DD
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/** EWMA with pandas' adjust=False semantics (y0 = x0, α = 2/(span+1)). */
function ewmaAdjustFalse(x: number[], span: number): number[] {
  const a = 2 / (span + 1);
  const out: number[] = [];
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    prev = i === 0 ? x[0] : a * x[i] + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

/**
 * PMC over a dense daily-TSS series (rest days = 0). `daily` must be sorted by
 * date with NO gaps (use dailyTssDense). Returns CTL/ATL/TSB per day.
 */
export function computePmc(daily: { date: string; tss: number }[], ctlDays = 42, atlDays = 7): PmcPoint[] {
  if (!daily.length) return [];
  const tss = daily.map((d) => d.tss || 0);
  const ctl = ewmaAdjustFalse(tss, ctlDays);
  const atl = ewmaAdjustFalse(tss, atlDays);
  return daily.map((d, i) => ({
    date: d.date,
    tss: +tss[i].toFixed(1),
    ctl: +ctl[i].toFixed(1),
    atl: +atl[i].toFixed(1),
    tsb: +(ctl[i] - atl[i]).toFixed(1),
  }));
}

/** TSB readiness label (Coggan-style form bands). */
export function formLabel(tsb: number): string {
  if (tsb > 15) return "Fresh / tapered";
  if (tsb > 5) return "Recovered";
  if (tsb >= -10) return "Neutral";
  if (tsb >= -30) return "Productive fatigue";
  return "Overreached";
}

/**
 * Build a dense day-by-day TSS series (Manila days, rest days filled 0) from
 * dated session loads. `items` = {dateIso 'YYYY-MM-DD', tss}. Summed per day,
 * gap-filled from first→last day. Day bucketing is the caller's job (Manila tz).
 */
export function dailyTssDense(items: { dateIso: string; tss: number }[]): { date: string; tss: number }[] {
  const byDay = new Map<string, number>();
  for (const it of items) {
    if (!it.dateIso || !isNum(it.tss)) continue;
    byDay.set(it.dateIso, (byDay.get(it.dateIso) || 0) + it.tss);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return [];
  const out: { date: string; tss: number }[] = [];
  const d = new Date(days[0] + "T00:00:00Z");
  const end = new Date(days[days.length - 1] + "T00:00:00Z");
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, tss: +(byDay.get(iso) || 0).toFixed(1) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
