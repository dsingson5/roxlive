/**
 * Threshold-run coaching: the "pace is the dose" reminder + the station buy-out
 * menu (from David's Pro-Track buy-out menu) for supra-MLSS threshold runs, and
 * the sub-threshold appendix. Detection is by workout title so it lights up for
 * built plans AND calendar-imported ones. Mirrored in the hub calendar's
 * day-modal script — keep the text in sync.
 */

export const PACE_IS_THE_DOSE =
  "The pace is the dose. Holding it constant for 8–12 weeks is what lets the adaptation actually express, rather than chasing a faster number each week and never adapting to any of them.";

export type ThresholdKind = "supra" | "sub";

/** Classify a workout title as a supra-MLSS threshold run, a sub-threshold run, or neither. */
export function classifyThresholdRun(title: string | undefined | null): ThresholdKind | null {
  const t = (title || "").toLowerCase();
  if (!t) return null;
  if (/strength|squat|bench|deadlift|\bpress\b|\bgym\b|\blift\b|hyrox/.test(t)) return null;
  // Sub-threshold is the more specific match — test it first.
  if (/sub[-\s]?thr|sub[-\s]?threshold|norwegian|10\s*[×x]\s*1\s*(k|km|000)/.test(t)) return "sub";
  if (/supra|thr\b|threshold|tempo|\bvo2|vo₂/.test(t)) return "supra";
  return null;
}

export interface BuyOut {
  name: string;
  detail: string;
  tibial: string;
}

/** Supra-MLSS threshold-run structure + the station buy-out menu. */
export const SUPRA_BUYOUT = {
  structure:
    "WU jog 12–15 min → threshold intervals (~30–35 min @ ~5:1 work:rest) → BUY-OUT at race effort (rest ~1 min first) → CD jog 12–15 min. Log the buy-out time.",
  menu: [
    { name: "Wall Ball", detail: "120 reps · 20/14# · 10/9 ft", tibial: "High (rebound) / Mod grounded" },
    { name: "Ski Erg", detail: "2 km @ threshold pace", tibial: "Near-zero" },
    { name: "Row", detail: "2 km @ threshold pace", tibial: "Near-zero" },
    { name: "AirBike", detail: "5 km @ race pace", tibial: "Near-zero" },
    { name: "Dual KB DL + Farmer Carry", detail: "3 rds: 10 DL + 100 m carry · 70/53#×2", tibial: "Low–Mod" },
    { name: "Sandbag Lunge", detail: "120 m · 65/45#", tibial: "Mod–High" },
    { name: "Sprint Strides", detail: "6 × 20 sec @ ~5 km pace", tibial: "High" },
  ] as BuyOut[],
  bsr:
    "BSR phase (distal tibia): rotate Row 2 km → Ski 2 km → AirBike 5 km — keeps the compromised-station-under-fatigue stimulus at ~zero tibial cost. Avoid Sandbag Lunge + Sprint Strides while BSR is active.",
};

/** Sub-threshold appendix — keep it clean (no race-pace finisher). */
export const SUB_BUYOUT = {
  rule: "No buy-out — keep it clean. The point is time-integrated sub-VT2 quality; a hard finisher spikes lactate and contaminates exactly the signal you're driving.",
  optional:
    "Optional (BSR-safe): after the final km, easy 2-min reset, then 1 km Ski Erg or Row at sub-threshold (~3 mmol / conversational-hard) effort — NOT race pace. Treat it as a 12th rep on another modality, not a finisher. Log the split.",
  avoid: "Don't add wall ball, sandbag lunge, strides or any sprint/plyo — that converts it to a threshold session and erases the polarization.",
};
