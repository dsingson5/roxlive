/**
 * Post-run refuel — ported from MBP-beta analysis.py post_run_refuel_rice_banana.
 * Carb-kcal/hr by zone & mode → replace 50% → grams → rice-cup & banana units.
 *   4 kcal/g carb · cooked white rice ≈ 45 g carb/cup · medium banana ≈ 27 g.
 */

type ZoneKey = "z1" | "z2" | "z3" | "z4" | "z5";

const RUN: Record<ZoneKey, [number, number]> = {
  z1: [434, 434],
  z2: [518, 599],
  z3: [713, 794],
  z4: [902, 1058],
  z5: [1058, 1058],
};
const BIKE: Record<ZoneKey, [number, number]> = {
  z1: [347, 347],
  z2: [414, 479],
  z3: [570, 635],
  z4: [722, 846],
  z5: [846, 846],
};

function tableFor(mode: string): Record<ZoneKey, [number, number]> {
  const m = (mode || "").toLowerCase();
  return m === "bike" ? BIKE : RUN; // erg/stairmaster/run/free → run table
}

export interface Refuel {
  carbGLo: number;
  carbGHi: number;
  riceCupsLo: number;
  riceCupsHi: number;
  bananasLo: number;
  bananasHi: number;
}

export function refuel(minutes: number, zoneKey: ZoneKey, mode: string): Refuel | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const [lo, hi] = tableFor(mode)[zoneKey] ?? tableFor(mode).z2;
  const hrs = minutes / 60;
  const gLo = (lo * hrs * 0.5) / 4;
  const gHi = (hi * hrs * 0.5) / 4;
  return {
    carbGLo: Math.round(gLo),
    carbGHi: Math.round(gHi),
    riceCupsLo: +(gLo / 45).toFixed(1),
    riceCupsHi: +(gHi / 45).toFixed(1),
    bananasLo: +(gLo / 27).toFixed(1),
    bananasHi: +(gHi / 27).toFixed(1),
  };
}
