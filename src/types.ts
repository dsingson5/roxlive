/**
 * RoxLive — shared type contract.
 * Every module (BLE, simulator, metrics engine, UI) builds against these types.
 * Units are SI unless stated: time = ms epoch, speed = m/s, R-R intervals = ms.
 */

/* ------------------------------------------------------------------ */
/* Samples                                                             */
/* ------------------------------------------------------------------ */

/** One heart-rate notification (from BLE 0x2A37 or the simulator). */
export interface HRSample {
  /** ms epoch timestamp of arrival */
  t: number;
  /** instantaneous heart rate, bpm */
  hr: number;
  /** R-R intervals delivered with this notification, in ms (often empty) */
  rr: number[];
  /** device id / "sim" */
  source: string;
}

/** One speed sample (GPS, simulator, or manual treadmill entry). */
export interface PaceSample {
  t: number;
  /** m/s; 0 when stationary */
  speedMps: number;
  source: "gps" | "sim" | "manual";
}

/* ------------------------------------------------------------------ */
/* Athlete profile & zones                                             */
/* ------------------------------------------------------------------ */

export interface AthleteProfile {
  name: string;
  age: number;
  maxHr: number;
  restHr: number;
  weightKg: number;
  division: "open" | "pro";
}

export const DEFAULT_PROFILE: AthleteProfile = {
  name: "Athlete",
  age: 32,
  maxHr: 190,
  restHr: 52,
  weightKg: 75,
  division: "open",
};

/** Zone upper bounds in bpm: [z1Top, z2Top, z3Top, z4Top]. Z5 tops at maxHr. */
export type ZoneBounds = [number, number, number, number];

/* ------------------------------------------------------------------ */
/* Metric outputs                                                      */
/* ------------------------------------------------------------------ */

export interface DfaResult {
  /** short-term scaling exponent alpha-1, or null when not computable */
  alpha1: number | null;
  /** % of beats rejected by the artifact filter inside the window */
  artifactPct: number;
  /** number of accepted beats in the window */
  beats: number;
  /** true when beats >= 64 and artifactPct <= 15 */
  reliable: boolean;
}

export interface HrvResult {
  /** rolling RMSSD over the window, ms */
  rmssd: number | null;
  /** rolling SDNN over the window, ms */
  sdnn: number | null;
  beats: number;
}

export interface RespirationResult {
  /** estimated breathing rate, breaths/min, or null */
  brpm: number | null;
  /** 0..1 spectral peak prominence — low values mean weak RSA signal */
  confidence: number;
}

export interface DecouplingResult {
  /** Pw:HR / Pa:HR drift percentage ((eff1 - eff2) / eff1 * 100), or null */
  pct: number | null;
  /** efficiency (speed/HR) of first and second half of the work period */
  firstHalf: number | null;
  secondHalf: number | null;
  /** true once >= 10 min of qualifying work time exists */
  ready: boolean;
  /** "speed" when speed data was available, "hr-drift" fallback otherwise */
  mode: "speed" | "hr-drift";
}

export type IntervalState = "idle" | "work" | "rest";

/* ------------------------------------------------------------------ */
/* Engine snapshot — the single object the UI renders from             */
/* ------------------------------------------------------------------ */

export interface MetricsSnapshot {
  t: number;
  elapsedSec: number;

  hr: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  /** current zone 1..5, or null before first sample */
  zone: number | null;
  zoneBounds: ZoneBounds;
  /** seconds accumulated per zone, index 0 = Z1 */
  zoneTimeSec: [number, number, number, number, number];
  /** %HRmax 0..100+ */
  pctMax: number | null;

  hrv: HrvResult;
  dfa: DfaResult;
  respiration: RespirationResult;
  decoupling: DecouplingResult;

  speedMps: number | null;
  /** sec per km, null when speed < 0.45 m/s */
  paceSecPerKm: number | null;
  distanceM: number;
  /** running cadence (steps/min), null when no cadence source / stale */
  cadence: number | null;
  /** core/body temperature °C, null when no thermometer / stale */
  bodyTempC: number | null;

  intervalState: IntervalState;
  /** completed work intervals */
  intervalCount: number;
  /** seconds in the current interval state */
  stateElapsedSec: number;

  kcal: number;
}

/** 1 Hz history point for charts (kept small on purpose). */
export interface SeriesPoint {
  t: number;
  hr: number | null;
  alpha1: number | null;
  speedMps: number | null;
  brpm: number | null;
  zone: number | null;
  cadence: number | null;
}

/* ------------------------------------------------------------------ */
/* HYROX race model                                                    */
/* ------------------------------------------------------------------ */

export type SegmentKind = "run" | "station";

export interface StationGuide {
  /** one-line pacing strategy */
  pacing: string;
  /** technique cues, 3-5 short imperative bullets */
  technique: string[];
  /** common mistakes to avoid, 2-3 bullets */
  mistakes: string[];
  /** what to do in the transition immediately after */
  exit: string;
  /** typical segment time targets, mm:ss strings */
  target: { open: string; pro: string };
}

export interface HyroxStation {
  id: string;
  /** e.g. "SkiErg" */
  name: string;
  /** workload e.g. "1000 m" (open + pro variants where they differ) */
  load: { open: string; pro: string };
  /** small emoji-free glyph label for the rail, e.g. "SKI" */
  short: string;
  guide: StationGuide;
}

/** One planned segment of a HYROX race (8 runs + 8 stations interleaved). */
export interface PlannedSegment {
  index: number;
  kind: SegmentKind;
  label: string;
  /** station definition when kind === "station" */
  station?: HyroxStation;
  /** rough planned duration in seconds (for ETA + simulator) */
  plannedSec: number;
}

/** A completed (or in-flight) segment during a session. */
export interface SegmentRecord {
  index: number;
  kind: SegmentKind;
  label: string;
  startT: number;
  endT: number | null;
  /** split seconds (endT-startT)/1000, null while in-flight */
  splitSec: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgAlpha1: number | null;
  distanceM: number;
}

/* ------------------------------------------------------------------ */
/* Workout plans (photo-imported / manual) + voice coaching            */
/* ------------------------------------------------------------------ */

export type TargetType = "zone" | "hr" | "pace" | "rpe" | "none";

export interface IntervalTarget {
  type: TargetType;
  /** 1..5 when type === "zone" */
  zone?: number | null;
  /** bpm bounds when type === "hr" */
  hrLow?: number | null;
  hrHigh?: number | null;
  /** human-readable label, e.g. "Zone 2", "150–160 bpm", "5:30 /km", "RPE 7" */
  label?: string;
}

export type WorkoutIntervalKind = "warmup" | "work" | "rest" | "active" | "cooldown";

export interface WorkoutInterval {
  id: string;
  name: string;
  kind: WorkoutIntervalKind;
  durationSec: number;
  target: IntervalTarget;
  notes?: string;
}

export interface WorkoutPlan {
  id: string;
  title: string;
  source: "photo" | "manual" | "sample";
  createdAt: number;
  intervals: WorkoutInterval[];
}

/** Raw structured output the vision model returns (before id assignment). */
export interface ParsedWorkout {
  title: string;
  intervals: {
    name: string;
    kind: WorkoutIntervalKind;
    durationSec: number;
    targetType: TargetType;
    zone?: number | null;
    hrLow?: number | null;
    hrHigh?: number | null;
    targetLabel?: string;
    notes?: string;
  }[];
}

export interface VoiceSettings {
  enabled: boolean;
  /** SpeechSynthesisVoice.voiceURI, or null for the browser default */
  voiceURI: string | null;
  rate: number; // 0.5..1.6
  pitch: number; // 0..2
  volume: number; // 0..1
  /** play a tone on the final-seconds countdown */
  beeps: boolean;
  /** lead-in "get ready" seconds before interval 1 */
  leadInSec: number;
}

export const DEFAULT_VOICE: VoiceSettings = {
  enabled: true,
  voiceURI: null,
  rate: 1,
  pitch: 1,
  volume: 1,
  beeps: true,
  leadInSec: 8,
};

export type RunnerPhase = "idle" | "leadin" | "running" | "done";
export type HrTargetStatus = "in" | "over" | "under" | "none";

/** Per-interval adherence accumulation. */
export interface IntervalAdherence {
  index: number;
  inTargetSec: number;
  totalSec: number;
  avgHr: number | null;
}

/* ------------------------------------------------------------------ */
/* Session persistence                                                 */
/* ------------------------------------------------------------------ */

/** Rate of Perceived Exertion (CR10, 1-10) for a session + optional per-segment. */
export interface RpeLog {
  overall: number | null;
  /** keyed by segment index → 1-10 */
  perSegment?: Record<number, number>;
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  mode: "free" | "hyrox" | "workout";
  /** post-workout perceived exertion */
  rpe?: RpeLog;
  /** workout-mode only: overall % of time spent inside target HR bands */
  adherencePct?: number | null;
  /** workout-mode only: the plan that was run */
  planTitle?: string;
  avgHr: number | null;
  maxHr: number | null;
  distanceM: number;
  kcal: number;
  zoneTimeSec: [number, number, number, number, number];
  decouplingPct: number | null;
  minAlpha1: number | null;
  avgBrpm: number | null;
  intervalCount: number;
  segments: SegmentRecord[];
  /** downsampled series for the summary chart (~1 point / 5 s) */
  series: SeriesPoint[];
}

/* ------------------------------------------------------------------ */
/* Device connectivity                                                 */
/* ------------------------------------------------------------------ */

export type DeviceStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface DeviceInfo {
  id: string;
  name: string;
  status: DeviceStatus;
  /** battery %, when the device exposes 0x180F */
  battery: number | null;
  /** true when this device's HR stream feeds the engine */
  primary: boolean;
  /** most recent HR seen from this device */
  lastHr: number | null;
  /** true if any notification so far contained R-R intervals */
  hasRR: boolean;
  /** true for the built-in simulator (vs a real BLE sensor) */
  simulated?: boolean;
  /** extra services discovered on a real sensor */
  hasCadence?: boolean;
  hasTemp?: boolean;
}
