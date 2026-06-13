/**
 * Workout-plan model helpers: target → HR-band resolution, sample plans,
 * localStorage persistence, and ParsedWorkout → WorkoutPlan adoption.
 */

import type {
  AthleteProfile,
  HrTargetStatus,
  IntervalTarget,
  ParsedWorkout,
  RunnerPhase,
  WorkoutInterval,
  WorkoutIntervalKind,
  WorkoutPlan,
} from "../types";
import { zoneBounds } from "./zones";

let idSeq = 0;
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Math.round(performance.now())}-${idSeq}`;
}

/** Resolve a target to an [low, high] HR band in bpm, or null if not HR-based. */
export function resolveBand(
  target: IntervalTarget,
  profile: AthleteProfile
): { low: number; high: number } | null {
  if (target.type === "hr" && target.hrLow != null && target.hrHigh != null) {
    return { low: Math.min(target.hrLow, target.hrHigh), high: Math.max(target.hrLow, target.hrHigh) };
  }
  if (target.type === "zone" && target.zone != null) {
    const b = zoneBounds(profile);
    const z = Math.max(1, Math.min(5, Math.round(target.zone)));
    const lowPctTop = [0, b[0], b[1], b[2], b[3]]; // bottom of each zone
    const highTop = [b[0], b[1], b[2], b[3], profile.maxHr];
    return { low: lowPctTop[z - 1], high: highTop[z - 1] };
  }
  return null;
}

/** A short label for a target, used in the UI and voice cues. */
export function targetLabel(target: IntervalTarget, profile?: AthleteProfile): string {
  if (target.label && target.label.trim()) return target.label.trim();
  if (target.type === "zone" && target.zone != null) return `Zone ${target.zone}`;
  if (target.type === "hr" && target.hrLow != null && target.hrHigh != null)
    return `${target.hrLow}–${target.hrHigh} bpm`;
  if (target.type === "pace") return "pace target";
  if (target.type === "rpe") return "RPE target";
  void profile;
  return "free";
}

export const KIND_LABEL: Record<WorkoutIntervalKind, string> = {
  warmup: "Warm-up",
  work: "Work",
  rest: "Rest",
  active: "Active",
  cooldown: "Cool-down",
};

export const KIND_COLOR: Record<WorkoutIntervalKind, string> = {
  warmup: "var(--color-z2)",
  work: "var(--color-volt)",
  rest: "var(--color-z2)",
  active: "var(--color-z3)",
  cooldown: "var(--color-cyan)",
};

export function planDurationSec(plan: WorkoutPlan): number {
  return plan.intervals.reduce((a, i) => a + Math.max(0, i.durationSec), 0);
}

/** A read-only snapshot of where an athlete is in their plan (no side effects). */
export interface RunnerView {
  phase: RunnerPhase;
  currentIndex: number;
  interval: WorkoutInterval | null;
  nextInterval: WorkoutInterval | null;
  remainingSec: number;
  fraction: number;
  band: { low: number; high: number } | null;
  hrStatus: HrTargetStatus;
  totalIntervals: number;
}

/**
 * Pure computation of plan progress at a given plan-elapsed time. Used for the
 * squad (one call per athlete per tick) and anywhere a non-hook view is needed.
 * `planElapsedSec < 0` (or no plan) → idle.
 */
export function computeRunnerView(
  plan: WorkoutPlan | null,
  profile: AthleteProfile,
  leadInSec: number,
  planElapsedSec: number,
  hr: number | null
): RunnerView {
  const base: RunnerView = {
    phase: "idle",
    currentIndex: -1,
    interval: null,
    nextInterval: plan?.intervals[0] ?? null,
    remainingSec: 0,
    fraction: 0,
    band: null,
    hrStatus: "none",
    totalIntervals: plan?.intervals.length ?? 0,
  };
  if (!plan || planElapsedSec < 0) return base;
  if (planElapsedSec < leadInSec) {
    return { ...base, phase: "leadin", remainingSec: Math.max(0, leadInSec - planElapsedSec) };
  }
  const t = planElapsedSec - leadInSec;
  const ends = cumulativeEnds(plan);
  const idx = ends.findIndex((e) => t < e);
  if (idx < 0) return { ...base, phase: "done", currentIndex: plan.intervals.length - 1, nextInterval: null };
  const interval = plan.intervals[idx];
  const start = idx > 0 ? ends[idx - 1] : 0;
  const ie = t - start;
  const band = resolveBand(interval.target, profile);
  let hrStatus: HrTargetStatus = "none";
  if (band && hr != null) hrStatus = hr < band.low ? "under" : hr > band.high ? "over" : "in";
  return {
    phase: "running",
    currentIndex: idx,
    interval,
    nextInterval: plan.intervals[idx + 1] ?? null,
    remainingSec: Math.max(0, interval.durationSec - ie),
    fraction: interval.durationSec > 0 ? Math.min(1, ie / interval.durationSec) : 0,
    band,
    hrStatus,
    totalIntervals: plan.intervals.length,
  };
}

/** Cumulative end-times (sec) for each interval. */
export function cumulativeEnds(plan: WorkoutPlan): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const i of plan.intervals) {
    acc += Math.max(0, i.durationSec);
    out.push(acc);
  }
  return out;
}

export function newInterval(partial?: Partial<WorkoutInterval>): WorkoutInterval {
  return {
    id: uid("iv"),
    name: partial?.name ?? "New interval",
    kind: partial?.kind ?? "work",
    durationSec: partial?.durationSec ?? 60,
    target: partial?.target ?? { type: "zone", zone: 3 },
    notes: partial?.notes,
  };
}

/** Convert the vision model's ParsedWorkout into an editable WorkoutPlan. */
export function adoptParsed(parsed: ParsedWorkout, source: WorkoutPlan["source"] = "photo"): WorkoutPlan {
  const intervals: WorkoutInterval[] = (parsed.intervals ?? []).map((iv) => {
    const target: IntervalTarget = {
      type: iv.targetType ?? "none",
      zone: iv.zone ?? null,
      hrLow: iv.hrLow ?? null,
      hrHigh: iv.hrHigh ?? null,
      label: iv.targetLabel,
    };
    return {
      id: uid("iv"),
      name: iv.name?.trim() || "Interval",
      kind: (iv.kind ?? "work") as WorkoutIntervalKind,
      durationSec: clampDur(iv.durationSec),
      target,
      notes: iv.notes,
    };
  });
  return {
    id: uid("plan"),
    title: parsed.title?.trim() || "Imported workout",
    source,
    createdAt: Math.round(performance.timeOrigin + performance.now()),
    intervals: intervals.length ? intervals : [newInterval()],
  };
}

function clampDur(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 60;
  return Math.min(3600, Math.round(v));
}

/* ---------------- persistence ---------------- */

const PLAN_KEY = "roxlive.plan.v1";

export function loadPlan(): WorkoutPlan | null {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    if (raw) return JSON.parse(raw) as WorkoutPlan;
  } catch {
    /* ignore */
  }
  return null;
}

export function savePlan(plan: WorkoutPlan | null): void {
  try {
    if (plan) localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    else localStorage.removeItem(PLAN_KEY);
  } catch {
    /* ignore */
  }
}

/* ---------------- sample plans ---------------- */

export function samplePlans(): WorkoutPlan[] {
  const now = Math.round(performance.timeOrigin + performance.now());
  const mk = (
    title: string,
    rows: [string, WorkoutIntervalKind, number, IntervalTarget, string?][]
  ): WorkoutPlan => ({
    id: uid("plan"),
    title,
    source: "sample",
    createdAt: now,
    intervals: rows.map(([name, kind, durationSec, target, notes]) => ({
      id: uid("iv"),
      name,
      kind,
      durationSec,
      target,
      notes,
    })),
  });

  return [
    mk("Threshold 4×4", [
      ["Warm-up", "warmup", 600, { type: "zone", zone: 2 }, "Easy, build gradually"],
      ["Interval 1", "work", 240, { type: "zone", zone: 4, label: "Z4 · threshold" }],
      ["Recovery 1", "rest", 180, { type: "zone", zone: 1 }],
      ["Interval 2", "work", 240, { type: "zone", zone: 4, label: "Z4 · threshold" }],
      ["Recovery 2", "rest", 180, { type: "zone", zone: 1 }],
      ["Interval 3", "work", 240, { type: "zone", zone: 4, label: "Z4 · threshold" }],
      ["Recovery 3", "rest", 180, { type: "zone", zone: 1 }],
      ["Interval 4", "work", 240, { type: "zone", zone: 4, label: "Z4 · threshold" }],
      ["Cool-down", "cooldown", 300, { type: "zone", zone: 1 }],
    ]),
    mk("Zone 2 Base", [
      ["Warm-up", "warmup", 300, { type: "zone", zone: 1 }],
      ["Aerobic block", "active", 2400, { type: "hr", hrLow: 130, hrHigh: 145, label: "130–145 bpm" }, "Hold steady, nasal breathing"],
      ["Cool-down", "cooldown", 300, { type: "zone", zone: 1 }],
    ]),
    mk("VO₂ 30/30", [
      ["Warm-up", "warmup", 600, { type: "zone", zone: 2 }],
      ...Array.from({ length: 10 }).flatMap((_, i) => [
        [`Hard ${i + 1}`, "work", 30, { type: "zone", zone: 5, label: "Z5 · max" }] as [string, WorkoutIntervalKind, number, IntervalTarget],
        [`Easy ${i + 1}`, "rest", 30, { type: "zone", zone: 1 }] as [string, WorkoutIntervalKind, number, IntervalTarget],
      ]),
      ["Cool-down", "cooldown", 300, { type: "zone", zone: 1 }],
    ]),
  ];
}
