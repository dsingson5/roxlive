/**
 * Aerobic decoupling (Pw:HR / Pa:HR drift) — a core PDF metric.
 *
 * Efficiency = speed / HR. Split the qualifying work period in half; if the
 * second half is less efficient (HR drifting up for the same speed), output is
 * positive drift %.  decoupling% = (eff_firstHalf − eff_secondHalf)/eff_firstHalf × 100.
 *
 * < 5%  -> well-coupled, good aerobic durability.
 * > 5%  -> notable cardiac drift / fatigue / heat strain.
 *
 * When no usable speed is present we fall back to "hr-drift" mode: pure HR rise
 * across the two halves (positive = HR climbing), which still flags drift.
 */

import type { DecouplingResult } from "../types";

export interface EffSample {
  t: number; // ms
  hr: number;
  speedMps: number | null;
}

const MIN_WORK_SEC = 600; // 10 min, the conventional minimum
const MIN_SPEED = 0.6; // m/s below which "speed" efficiency is meaningless

export function computeDecoupling(samples: EffSample[]): DecouplingResult {
  if (samples.length < 10) {
    return { pct: null, firstHalf: null, secondHalf: null, ready: false, mode: "speed" };
  }

  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const spanSec = (t1 - t0) / 1000;
  const ready = spanSec >= MIN_WORK_SEC;
  const mid = t0 + (t1 - t0) / 2;

  const hasSpeed = samples.filter((s) => s.speedMps !== null && s.speedMps >= MIN_SPEED).length >
    samples.length * 0.5;

  if (hasSpeed) {
    const first = avgEff(samples.filter((s) => s.t <= mid));
    const second = avgEff(samples.filter((s) => s.t > mid));
    if (first === null || second === null || first === 0) {
      return { pct: null, firstHalf: first, secondHalf: second, ready, mode: "speed" };
    }
    const pct = ((first - second) / first) * 100;
    return { pct, firstHalf: first, secondHalf: second, ready, mode: "speed" };
  }

  // HR-drift fallback: compare mean HR of the two halves.
  const hr1 = avgHr(samples.filter((s) => s.t <= mid));
  const hr2 = avgHr(samples.filter((s) => s.t > mid));
  if (hr1 === null || hr2 === null || hr1 === 0) {
    return { pct: null, firstHalf: hr1, secondHalf: hr2, ready, mode: "hr-drift" };
  }
  const pct = ((hr2 - hr1) / hr1) * 100;
  return { pct, firstHalf: hr1, secondHalf: hr2, ready, mode: "hr-drift" };
}

function avgEff(arr: EffSample[]): number | null {
  let sum = 0;
  let n = 0;
  for (const s of arr) {
    if (s.speedMps !== null && s.speedMps >= MIN_SPEED && s.hr > 0) {
      sum += s.speedMps / s.hr;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

function avgHr(arr: EffSample[]): number | null {
  let sum = 0;
  let n = 0;
  for (const s of arr) {
    if (s.hr > 0) {
      sum += s.hr;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}
