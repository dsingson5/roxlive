/**
 * Shared helpers for the post-run analytics ported from MBP-beta.
 *
 * RoxLive's live series buffer is ~1 Hz on the ACTIVE timeline; the *stored*
 * summary series is downsampled (~5 s). So every function here is dt-weighted
 * off each point's timestamp rather than assuming 1 Hz — it gives identical
 * results on the live 1 Hz path and stays correct on the downsampled path.
 */

import type { SeriesPoint } from "../../types";

export interface Prof {
  maxHr: number;
  restHr: number;
  weightKg?: number;
  age?: number;
  sex?: "male" | "female";
}

/** Per-sample dt in seconds. First sample inherits the median dt; gaps clamped. */
export function dts(pts: SeriesPoint[]): number[] {
  const n = pts.length;
  if (n === 0) return [];
  const d = new Array<number>(n);
  for (let i = 1; i < n; i++) d[i] = (pts[i].t - pts[i - 1].t) / 1000;
  const rest = d.slice(1).filter((x) => x > 0).sort((a, b) => a - b);
  const med = rest.length ? rest[Math.floor(rest.length / 2)] : 1;
  // base = the series' OWN sample cadence (1 Hz live; ~5-12 s for a stored/
  // downsampled trace). Clamp only gaps that are clearly PAUSES — bigger than
  // 3× the cadence (and at least 10 s). A hard 10 s ceiling would collapse a
  // uniformly >10 s-strided long session to a fixed step and halve its timeline.
  const base = Math.max(0.5, med || 1);
  const cap = Math.max(10, base * 3);
  d[0] = base;
  for (let i = 1; i < n; i++) if (!(d[i] > 0) || d[i] > cap) d[i] = base;
  return d;
}

/** dt-weighted mean of a selector over valid (finite) samples. */
export function wmean(pts: SeriesPoint[], d: number[], sel: (p: SeriesPoint) => number | null | undefined): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < pts.length; i++) {
    const v = sel(pts[i]);
    if (v != null && Number.isFinite(v)) {
      s += (v as number) * d[i];
      w += d[i];
    }
  }
  return w > 0 ? s / w : NaN;
}

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Map a RoxLive modality/mode to the family the ported MBP tables expect
 * ("run" | "bike" | "erg"). RoxLive's enum is bike_erg / indoor_bike /
 * outdoor_bike / row_erg / ski_erg / run / walk / … — none of which equal the
 * bare "bike"/"erg" strings MBP tested, so without this every ride fell through
 * to the RUN decoupling bands + RUN carb table.
 */
export function mbpFamily(mode: string): "run" | "bike" | "erg" {
  const m = (mode || "").toLowerCase();
  if (/bike/.test(m)) return "bike"; // bike_erg / indoor_bike / outdoor_bike
  if (/row_erg|ski_erg|(^|_)erg$/.test(m)) return "erg";
  return "run"; // run / walk / stairmaster / free / hyrox / workout / other
}

/** Dominant HR zone key ("z1".."z5") from a [z1..z5] seconds tuple. */
export function dominantZone(zoneTimeSec: readonly number[]): "z1" | "z2" | "z3" | "z4" | "z5" {
  let best = 0;
  for (let i = 1; i < 5; i++) if ((zoneTimeSec[i] ?? 0) > (zoneTimeSec[best] ?? 0)) best = i;
  return (["z1", "z2", "z3", "z4", "z5"] as const)[best];
}
