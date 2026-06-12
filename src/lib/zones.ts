/**
 * HR-zone model. Five zones anchored to %HRmax with thresholds at
 * 60 / 70 / 80 / 90 %HRmax — the classic 5-zone split used for the
 * "HR-zone segmentation" the PDF lists as a core real-time metric.
 */

import type { AthleteProfile, ZoneBounds } from "../types";

export interface ZoneDef {
  z: number;
  name: string;
  color: string;
  loPct: number;
  hiPct: number;
}

export const ZONE_DEFS: ZoneDef[] = [
  { z: 1, name: "Recovery", color: "var(--color-z1)", loPct: 0, hiPct: 60 },
  { z: 2, name: "Aerobic", color: "var(--color-z2)", loPct: 60, hiPct: 70 },
  { z: 3, name: "Tempo", color: "var(--color-z3)", loPct: 70, hiPct: 80 },
  { z: 4, name: "Threshold", color: "var(--color-z4)", loPct: 80, hiPct: 90 },
  { z: 5, name: "VO2 / Max", color: "var(--color-z5)", loPct: 90, hiPct: 100 },
];

export const ZONE_COLORS = ZONE_DEFS.map((z) => z.color);

export function zoneBounds(profile: AthleteProfile): ZoneBounds {
  const m = profile.maxHr;
  return [
    Math.round(m * 0.6),
    Math.round(m * 0.7),
    Math.round(m * 0.8),
    Math.round(m * 0.9),
  ];
}

/** Returns zone 1..5 for a heart rate given the athlete's max. */
export function zoneForHr(hr: number, bounds: ZoneBounds): number {
  if (hr < bounds[0]) return 1;
  if (hr < bounds[1]) return 2;
  if (hr < bounds[2]) return 3;
  if (hr < bounds[3]) return 4;
  return 5;
}

export function pctMax(hr: number, maxHr: number): number {
  return (hr / maxHr) * 100;
}

/** Karvonen %HRR for display context. */
export function pctReserve(hr: number, profile: AthleteProfile): number {
  const range = profile.maxHr - profile.restHr;
  if (range <= 0) return 0;
  return ((hr - profile.restHr) / range) * 100;
}
