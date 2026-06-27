/**
 * Efficiency + intensity — ported from MBP-beta analysis.py / terrain.py.
 *
 *  - Efficiency Factor (EF): output ÷ HR (speed km/h per bpm; 1000/HR proxy when
 *    no speed), the economy/durability metric the hub progress chart plots by hand
 *  - Cardiac cost: beats per km (pace-independent durability)
 *  - Decoupling classification: mode-aware 3-band verdict + negative-drift cases
 *  - Intensity context: %HRmax, Karvonen %HRR, zone label
 */

import type { SeriesPoint } from "../../types";
import { dts, wmean, isNum, type Prof } from "./util";

export interface EfResult {
  ef: number;
  mode: "speed" | "hr";
  avgOut: number;
  avgHr: number;
}

/** EF = avg(speed m/min)/avg(HR); HR-only proxy = 1000/avgHR when no speed. */
export function efficiencyFactor(pts: SeriesPoint[]): EfResult | null {
  const valid = pts.filter((p) => p.hr != null && Number.isFinite(p.hr) && (p.hr as number) > 0 && (p.hr as number) < 250);
  if (valid.length < 10) return null;
  // Speed mode: compute BOTH numerator and denominator over the MOVING rows only
  // (speed>0), so a mixed/HYROX session's stationary station HR doesn't dilute the
  // denominator and inflate EF. m/min per bpm matches David's hub progress chart (~1.2).
  const moving = valid.filter((p) => p.speedMps != null && (p.speedMps as number) > 0);
  if (moving.length >= 10) {
    const dm = dts(moving);
    const avgMpm = wmean(moving, dm, (p) => (p.speedMps as number) * 60);
    const avgHrMov = wmean(moving, dm, (p) => p.hr);
    if (isNum(avgMpm) && avgMpm > 0 && isNum(avgHrMov) && avgHrMov > 0) {
      return { ef: +(avgMpm / avgHrMov).toFixed(3), mode: "speed", avgOut: +avgMpm.toFixed(0), avgHr: +avgHrMov.toFixed(0) };
    }
  }
  const dv = dts(valid);
  const avgHr = wmean(valid, dv, (p) => p.hr);
  if (!isNum(avgHr) || avgHr <= 0) return null;
  return { ef: +(1000 / avgHr).toFixed(2), mode: "hr", avgOut: +avgHr.toFixed(0), avgHr: +avgHr.toFixed(0) };
}

export interface CardiacCost {
  beatsPerKm: number;
  risePct: number | null; // 2nd-half vs 1st-half beats/km
}

/** Cardiac cost (beats/km) over the moving series, with first/second-half rise. */
export function cardiacCost(pts: SeriesPoint[]): CardiacCost | null {
  const d = dts(pts);
  let beats = 0;
  let km = 0;
  const cum: { beats: number; km: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const hr = pts[i].hr;
    const sp = pts[i].speedMps;
    if (hr != null && Number.isFinite(hr) && hr > 0) beats += (hr * d[i]) / 60;
    if (sp != null && Number.isFinite(sp) && sp > 0) km += (sp * d[i]) / 1000;
    cum.push({ beats, km });
  }
  if (km <= 0) return null;
  const bpkm = beats / km;
  // halves by total time
  const total = d.reduce((a, b) => a + b, 0);
  let half = 0;
  let acc = 0;
  for (let i = 0; i < d.length; i++) {
    acc += d[i];
    if (acc >= total / 2) {
      half = i;
      break;
    }
  }
  let rise: number | null = null;
  const c1 = cum[half];
  const cLast = cum[cum.length - 1];
  if (c1 && c1.km > 0 && cLast.km - c1.km > 0) {
    const bp1 = c1.beats / c1.km;
    const bp2 = (cLast.beats - c1.beats) / (cLast.km - c1.km);
    if (bp1 > 0) rise = +(((bp2 - bp1) / bp1) * 100).toFixed(1);
  }
  return { beatsPerKm: +bpkm.toFixed(1), risePct: rise };
}

/** MBP classify_decoupling: mode-aware bands + negative-drift handling. */
export function classifyDecoupling(decouplingPct: number, mode: string): string {
  const m = (mode || "").toLowerCase();
  const erg = m === "bike" || m === "erg";
  const target = erg ? "watts/duration" : m === "run" ? "pace/distance" : "output/duration";
  const low = erg ? 3 : 5;
  const high = erg ? 5 : 8;
  if (decouplingPct < 0) {
    return m === "run"
      ? "Unreliable (likely terrain/conditions artifact — negative drift)"
      : "Caution — negative drift; consider a flush/deload";
  }
  if (decouplingPct < low) return `Elite — can increase ${target}`;
  if (decouplingPct <= high) return `Adapting — maintain ${target}`;
  return `High drift — lessen ${target}`;
}

export interface Intensity {
  pctMax: number;
  pctHrr: number | null;
  zone: string;
}

/** %HRmax, Karvonen %HRR, and a zone label from avg/max/rest HR. */
export function intensityContext(avgHr: number, prof: Prof): Intensity | null {
  const { maxHr, restHr } = prof;
  if (!isNum(avgHr) || !isNum(maxHr) || maxHr <= 0 || avgHr <= 0) return null;
  const pctMax = +((avgHr / maxHr) * 100).toFixed(1);
  let pctHrr: number | null = null;
  if (isNum(restHr) && restHr > 0 && maxHr - restHr > 0) pctHrr = +(((avgHr - restHr) / (maxHr - restHr)) * 100).toFixed(1);
  const zone = pctMax < 60 ? "Recovery" : pctMax < 70 ? "Easy" : pctMax < 80 ? "Moderate" : pctMax < 90 ? "Threshold" : "VO₂max";
  return { pctMax, pctHrr, zone };
}
