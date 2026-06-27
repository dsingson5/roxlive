import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AthleteProfile,
  HrTargetStatus,
  IntervalAdherence,
  RunnerPhase,
  VoiceSettings,
  WorkoutInterval,
  WorkoutPlan,
} from "../types";
import { VoiceCoach } from "../lib/voice";
import { cumulativeEnds, resolveBand, targetLabel } from "../lib/workout";

export interface RunnerState {
  phase: RunnerPhase;
  currentIndex: number; // -1 during lead-in
  interval: WorkoutInterval | null;
  nextInterval: WorkoutInterval | null;
  remainingSec: number; // remaining in current interval (or lead-in)
  intervalElapsedSec: number;
  fraction: number; // 0..1 progress through current interval
  band: { low: number; high: number } | null;
  hrStatus: HrTargetStatus;
  totalIntervals: number;
  adherencePct: number | null;
  perInterval: IntervalAdherence[];
}

const num = (w: number) =>
  ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][w] ?? String(w);

export function useWorkoutRunner(args: {
  plan: WorkoutPlan | null;
  profile: AthleteProfile;
  voice: VoiceSettings;
  active: boolean;
  elapsedSec: number;
  hr: number | null;
}) {
  const { plan, profile, voice, active, elapsedSec, hr } = args;

  const coachRef = useRef<VoiceCoach | null>(null);
  if (coachRef.current === null) coachRef.current = new VoiceCoach(voice);
  useEffect(() => coachRef.current!.setSettings(voice), [voice]);

  const ends = useMemo(() => (plan ? cumulativeEnds(plan) : []), [plan]);
  const leadIn = voice.leadInSec;

  // cue + adherence bookkeeping
  const fired = useRef<Set<string>>(new Set());
  const acc = useRef<{ inTargetSec: number; totalSec: number; hrSum: number; hrW: number }[]>([]);
  const lastElapsed = useRef(0);
  const prevActive = useRef(false);
  const planId = useRef<string | null>(null);
  const publishedSec = useRef(-1);
  const [adherence, setAdherence] = useState<{ pct: number | null; per: IntervalAdherence[] }>({
    pct: null,
    per: [],
  });

  // Reset accumulators when a run (re)starts or the plan changes.
  useEffect(() => {
    const startedRun = active && !prevActive.current;
    const planChanged = plan?.id !== planId.current;
    if (startedRun || planChanged) {
      fired.current = new Set();
      acc.current = (plan?.intervals ?? []).map(() => ({ inTargetSec: 0, totalSec: 0, hrSum: 0, hrW: 0 }));
      lastElapsed.current = elapsedSec;
      setAdherence({ pct: null, per: [] });
      planId.current = plan?.id ?? null;
    }
    if (!active && prevActive.current) coachRef.current!.cancel();
    prevActive.current = active;
  }, [active, plan, elapsedSec]);

  // Derived live state.
  const state: RunnerState = useMemo(() => {
    const base: RunnerState = {
      phase: "idle",
      currentIndex: -1,
      interval: null,
      nextInterval: null,
      remainingSec: 0,
      intervalElapsedSec: 0,
      fraction: 0,
      band: null,
      hrStatus: "none",
      totalIntervals: plan?.intervals.length ?? 0,
      adherencePct: adherence.pct,
      perInterval: adherence.per,
    };
    if (!plan || !active) return base;

    if (elapsedSec < leadIn) {
      return {
        ...base,
        phase: "leadin",
        remainingSec: Math.max(0, leadIn - elapsedSec),
        nextInterval: plan.intervals[0] ?? null,
      };
    }
    const t = elapsedSec - leadIn;
    let idx = ends.findIndex((e) => t < e);
    if (idx < 0) {
      return { ...base, phase: "done", currentIndex: plan.intervals.length - 1 };
    }
    const interval = plan.intervals[idx];
    const start = idx > 0 ? ends[idx - 1] : 0;
    const intervalElapsed = t - start;
    const remaining = Math.max(0, interval.durationSec - intervalElapsed);
    const band = resolveBand(interval.target, profile);
    let hrStatus: HrTargetStatus = "none";
    if (band && hr != null) hrStatus = hr < band.low ? "under" : hr > band.high ? "over" : "in";
    return {
      ...base,
      phase: "running",
      currentIndex: idx,
      interval,
      nextInterval: plan.intervals[idx + 1] ?? null,
      remainingSec: remaining,
      intervalElapsedSec: intervalElapsed,
      fraction: interval.durationSec > 0 ? Math.min(1, intervalElapsed / interval.durationSec) : 0,
      band,
      hrStatus,
    };
  }, [plan, active, elapsedSec, leadIn, ends, profile, hr, adherence]);

  // Voice cues (edge-triggered via the fired set).
  useEffect(() => {
    if (!active || !plan) return;
    const coach = coachRef.current!;
    const once = (token: string, fn: () => void) => {
      if (fired.current.has(token)) return;
      fired.current.add(token);
      fn();
    };

    // Spoken "how you did" verdict for a just-finished interval (or "" if N/A).
    const verdict = (idx: number): string => {
      const b = acc.current[idx];
      const ivPrev = plan.intervals[idx];
      if (!b || !ivPrev || b.totalSec < 5) return "";
      const avg = b.hrW > 0 ? Math.round(b.hrSum / b.hrW) : null;
      const pb = resolveBand(ivPrev.target, profile);
      if (avg == null) return ""; // no HR captured this interval — nothing to judge
      if (!pb) return `Last interval, averaged ${avg}.`;
      const pct = Math.round((b.inTargetSec / b.totalSec) * 100);
      const lead =
        pct >= 85 ? "Nailed it" :
        pct >= 60 ? "Solid" :
        avg != null && avg < pb.low ? "That one was easy" :
        avg != null && avg > pb.high ? "Pushed past target" :
        "Keep working it";
      return `${lead}. ${pct} percent in target last interval${avg != null ? `, averaged ${avg}` : ""}.`;
    };

    if (state.phase === "leadin") {
      once("leadin", () => coach.say(`Get ready. First up, ${plan.intervals[0]?.name ?? "your workout"}.`));
      const n = Math.ceil(state.remainingSec);
      if (n >= 1 && n <= 3 && state.remainingSec > 0) {
        once(`leadin:cd:${n}`, () => {
          coach.say(num(n));
          coach.beep(720, 100);
        });
      }
    } else if (state.phase === "running") {
      const i = state.currentIndex;
      const iv = state.interval!;
      once(`start:${i}`, () => {
        coach.beep(1046, 160);
        // how the previous interval went (queued before the new interval's call-out)
        if (i > 0) { const v = verdict(i - 1); if (v) coach.say(v); }
        const tl = labelFor(iv, profile);
        coach.say(tl ? `${iv.name}. ${tl}.` : `${iv.name}.`);
      });
      if (iv.durationSec >= 24) {
        if (state.intervalElapsedSec >= iv.durationSec / 2) once(`half:${i}`, () => coach.say("Halfway."));
      }
      // ~20 s before this interval ends, preview the incoming one (needs an
      // interval long enough for a 20 s lead, and a next interval to preview).
      if (state.nextInterval && iv.durationSec >= 22 && state.remainingSec <= 20.5 && state.remainingSec > 11) {
        once(`next:${i}`, () => {
          const nx = state.nextInterval!;
          const tl = labelFor(nx, profile);
          coach.say(`Coming up, ${nx.name}${tl ? `, ${tl}` : ""}.`);
        });
      }
      if (iv.durationSec > 20 && state.remainingSec <= 10.4 && state.remainingSec > 5.5) {
        once(`ten:${i}`, () => coach.say("Ten seconds."));
      }
      const n = Math.ceil(state.remainingSec);
      if (n >= 1 && n <= 5 && state.remainingSec > 0.05) {
        once(`cd:${i}:${n}`, () => {
          coach.say(num(n));
          coach.beep(n === 1 ? 660 : 760, 90);
        });
      }
    } else if (state.phase === "done") {
      once("done", () => {
        coach.beep(880, 200);
        const v = verdict((plan.intervals.length ?? 0) - 1); // the final interval's result
        if (v) coach.say(v);
        coach.say("Workout complete. Great work.");
      });
    }
  }, [state, active, plan, profile]);

  // Adherence accumulation (throttled state update at ~1 Hz).
  useEffect(() => {
    if (!active || state.phase !== "running") {
      lastElapsed.current = elapsedSec;
      return;
    }
    const dt = Math.max(0, Math.min(1.5, elapsedSec - lastElapsed.current));
    lastElapsed.current = elapsedSec;
    const i = state.currentIndex;
    const bucket = acc.current[i];
    if (bucket && state.band) {
      bucket.totalSec += dt;
      if (hr != null) {
        bucket.hrSum += hr * dt;
        bucket.hrW += dt;
        if (state.hrStatus === "in") bucket.inTargetSec += dt;
      }
    }
    // publish ~1 Hz
    const sec = Math.floor(elapsedSec);
    if (sec !== publishedSec.current) {
      publishedSec.current = sec;
      let totIn = 0;
      let totAll = 0;
      const per: IntervalAdherence[] = acc.current.map((b, idx) => {
        totIn += b.inTargetSec;
        totAll += b.totalSec;
        return {
          index: idx,
          inTargetSec: b.inTargetSec,
          totalSec: b.totalSec,
          avgHr: b.hrW > 0 ? b.hrSum / b.hrW : null,
        };
      });
      setAdherence({ pct: totAll > 0 ? (totIn / totAll) * 100 : null, per });
    }
  }, [elapsedSec, active, state, hr]);

  return { coach: coachRef.current!, state };
}

function labelFor(iv: WorkoutInterval, profile: AthleteProfile): string {
  if (iv.target.type === "none") return "";
  return targetLabel(iv.target, profile);
}
