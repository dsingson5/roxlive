/**
 * Workout modality (sport type) catalog. A session is either a single modality
 * (all run / all row / all bike-erg …) or "mixed" — each interval a different
 * movement (HYROX, CrossFit). Used for classification, history filtering, and
 * the FIT sport/sub-sport fields so platforms categorise the activity correctly.
 */

export type Modality =
  | "run"
  | "walk"
  | "ski_erg"
  | "row_erg"
  | "bike_erg"
  | "indoor_bike"
  | "outdoor_bike"
  | "swim"
  | "strength"
  | "other"
  | "mixed";

export interface ModalityDef {
  id: Modality;
  label: string;
  short: string;
  glyph: string;
  /** FIT sport / sub_sport codes (Garmin FIT profile) */
  fitSport: number;
  fitSub: number;
}

// FIT sport: 0 generic,1 running,2 cycling,5 swimming,10 training,11 walking,
// 15 rowing,4 fitness_equipment. sub_sport: 0 generic,1 treadmill,6 indoor_cycling,
// 14 indoor_rowing,62 indoor_running,63 indoor_walking, etc.
export const MODALITIES: ModalityDef[] = [
  { id: "run", label: "Run", short: "Run", glyph: "🏃", fitSport: 1, fitSub: 0 },
  { id: "walk", label: "Walk", short: "Walk", glyph: "🚶", fitSport: 11, fitSub: 0 },
  { id: "ski_erg", label: "Ski Erg", short: "Ski", glyph: "🎿", fitSport: 4, fitSub: 0 },
  { id: "row_erg", label: "Row Erg", short: "Row", glyph: "🚣", fitSport: 15, fitSub: 14 },
  { id: "bike_erg", label: "Bike Erg", short: "BikeErg", glyph: "🚴", fitSport: 2, fitSub: 6 },
  { id: "indoor_bike", label: "Indoor Bike", short: "Indoor", glyph: "🚲", fitSport: 2, fitSub: 6 },
  { id: "outdoor_bike", label: "Outdoor Bike", short: "OutBike", glyph: "🚵", fitSport: 2, fitSub: 0 },
  { id: "swim", label: "Swim", short: "Swim", glyph: "🏊", fitSport: 5, fitSub: 0 },
  { id: "strength", label: "Strength", short: "Strength", glyph: "🏋️", fitSport: 10, fitSub: 0 },
  { id: "other", label: "Other", short: "Other", glyph: "⚡", fitSport: 0, fitSub: 0 },
  { id: "mixed", label: "Mixed (per-interval)", short: "Mixed", glyph: "🔀", fitSport: 10, fitSub: 0 },
];

const MAP: Record<Modality, ModalityDef> = Object.fromEntries(MODALITIES.map((m) => [m.id, m])) as Record<
  Modality,
  ModalityDef
>;

export function modalityDef(id: Modality | undefined | null): ModalityDef {
  return (id && MAP[id]) || MAP.other;
}

export function modalityLabel(id: Modality | undefined | null): string {
  return modalityDef(id).label;
}

/** Single-modality options (excludes "mixed"). */
export const SINGLE_MODALITIES = MODALITIES.filter((m) => m.id !== "mixed");

/** Best-effort guess of a station/interval's modality from its name. */
export function guessModality(name: string): Modality {
  const n = name.toLowerCase();
  if (/ski/.test(n)) return "ski_erg";
  if (/row/.test(n)) return "row_erg";
  if (/bikeerg|bike erg|\bbike\b|cycl|watt/.test(n)) return "bike_erg";
  if (/run/.test(n)) return "run";
  if (/walk|lunge|carry|sled/.test(n)) return "walk";
  if (/swim/.test(n)) return "swim";
  if (/wall ball|burpee|squat|press|clean|snatch|deadlift|push|pull|strength/.test(n)) return "strength";
  return "other";
}
