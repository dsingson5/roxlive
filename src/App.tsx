import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useEngine } from "./hooks/useEngine";
import { useWorkoutRunner } from "./hooks/useWorkoutRunner";
import type {
  SegmentRecord,
  SeriesPoint,
  SessionSummary,
  PlannedSegment,
  AthleteProfile,
  WorkoutPlan,
  VoiceSettings,
} from "./types";
import { DEFAULT_VOICE } from "./types";
import { buildRace } from "./data/hyrox";
import { selfTestDFA } from "./lib/dfa";
import { cumulativeEnds, loadPlan, resolveBand, savePlan } from "./lib/workout";
import { VISION_MODELS } from "./lib/vision";
import { VoiceCoach } from "./lib/voice";
import { addToHistory, clearHistory, deleteFromHistory, loadHistory } from "./lib/history";
import { TopBar } from "./components/TopBar";
import { HeroHR, DfaGauge } from "./components/HeroPanels";
import { LiveChart } from "./components/LiveChart";
import {
  DecouplingCard,
  HrvCard,
  BreathingCard,
  PaceCard,
  IntervalCard,
  ZoneBars,
  InsightPanel,
} from "./components/StatCards";
import { RaceRail } from "./components/RaceRail";
import { StationGuide } from "./components/StationGuide";
import { GuidedRun } from "./components/GuidedRun";
import { WorkoutRail } from "./components/WorkoutRail";
import { WorkoutBuilder } from "./components/WorkoutBuilder";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { SummaryModal } from "./components/SummaryModal";
import { HistoryModal } from "./components/HistoryModal";
import { CountdownOverlay } from "./components/CountdownOverlay";

export default function App() {
  const eng = useEngine();
  const { snapshot: snap, series, profile } = eng;

  const [raceMode, setRaceMode] = useState<"free" | "hyrox" | "workout">("hyrox");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [manualFocus, setManualFocus] = useState<number | null>(null);

  // Workout history (persisted locally).
  const [history, setHistory] = useState<SessionSummary[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<SessionSummary | null>(null);

  // Workout-mode state (persisted locally).
  const [plan, setPlan] = useState<WorkoutPlan | null>(() => loadPlan());
  const [voice, setVoice] = useState<VoiceSettings>(() => loadVoice());
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem("roxlive.apiKey") ?? "");
  const [visionModel, setVisionModel] = useState<string>(() => localStorage.getItem("roxlive.model") ?? VISION_MODELS[0].id);
  const [builderOpen, setBuilderOpen] = useState(false);

  const segments = useMemo(() => buildRace(), []);

  // Workout start gate: the plan clock (voice cues, countdowns, adherence)
  // only runs after the user explicitly presses START. `workoutAnchor` is the
  // real-ms timestamp of that press; before it, a connected source just
  // streams HR (warm-up) without starting the workout.
  const [workoutAnchor, setWorkoutAnchor] = useState<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const planFnRef = useRef<((tSec: number) => number | null) | null>(null);
  const fullSeriesRef = useRef<SeriesPoint[]>([]);

  // HYROX voice coach (separate from the workout runner's coach).
  // Lazy-init so the constructor runs once, not on every render.
  const hyroxCoachRef = useRef<VoiceCoach | null>(null);
  if (hyroxCoachRef.current === null) hyroxCoachRef.current = new VoiceCoach(voice);
  const hyroxCoach = hyroxCoachRef as React.MutableRefObject<VoiceCoach>;
  const hyroxFired = useRef<Set<string>>(new Set());
  useEffect(() => hyroxCoach.current.setSettings(voice), [voice, hyroxCoach]);

  useEffect(() => {
    planFnRef.current = plan ? planTargetHr(plan, voice.leadInSec, profile) : null;
  }, [plan, voice.leadInSec, profile]);

  // Handed to the simulator once: easy warm-up HR until START, then the plan.
  const simTargetFn = useCallback((_simElapsedSec: number): number | null => {
    if (anchorRef.current == null || !planFnRef.current) return null;
    const t = (performance.timeOrigin + performance.now() - anchorRef.current) / 1000;
    return planFnRef.current(t);
  }, []);

  const workoutActive =
    raceMode === "workout" && eng.mode !== "idle" && !!plan && workoutAnchor != null;
  const runner = useWorkoutRunner({
    plan,
    profile,
    voice,
    active: workoutActive,
    elapsedSec: workoutAnchor != null ? Math.max(0, (snap.t - workoutAnchor) / 1000) : 0,
    hr: snap.hr,
  });

  const persistVoice = (v: VoiceSettings) => {
    setVoice(v);
    try {
      localStorage.setItem("roxlive.voice", JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };
  const persistApiKey = (k: string) => {
    setApiKey(k);
    try {
      localStorage.setItem("roxlive.apiKey", k);
    } catch {
      /* ignore */
    }
  };
  const persistModel = (m: string) => {
    setVisionModel(m);
    try {
      localStorage.setItem("roxlive.model", m);
    } catch {
      /* ignore */
    }
  };

  const clearAnchor = () => {
    anchorRef.current = null;
    setWorkoutAnchor(null);
  };

  // Demo / Connect just bring a HR source online. In workout mode nothing is
  // guided yet — the plan waits for the explicit START press.
  const armHyroxVoice = () => {
    // user gesture → unlock speech for HYROX countdowns; reset per-run cues
    hyroxFired.current = new Set();
    if (raceMode === "hyrox") hyroxCoach.current.prime();
  };
  const handleDemo = () => {
    armHyroxVoice();
    if (raceMode === "workout" && plan) eng.startDemo({ targetHrFn: simTargetFn });
    else eng.startDemo();
  };
  const handleConnect = () => {
    armHyroxVoice();
    void eng.connect();
  };

  /**
   * The explicit START press — the only thing that begins the guided plan.
   * A source (real sensor or simulator) must already be live; we never
   * silently start the simulator here.
   */
  const handleStartWorkout = () => {
    if (!plan || eng.mode === "idle") return;
    runner.coach.prime(); // user gesture: unlock speech synthesis + audio
    const t = performance.timeOrigin + performance.now();
    anchorRef.current = t;
    setWorkoutAnchor(t);
  };

  const handleModeChange = (m: "free" | "hyrox" | "workout") => {
    setRaceMode(m);
    hyroxFired.current = new Set(); // avoid stale countdown tokens across modes
    if (m !== "workout") clearAnchor();
    if (m === "workout" && !plan) setBuilderOpen(true);
  };

  /** Builder's primary CTA: adopt the plan and arm it — never auto-start. */
  const adoptWorkout = (p: WorkoutPlan) => {
    setPlan(p);
    savePlan(p);
    setBuilderOpen(false);
    setRaceMode("workout");
  };

  const savePlanAndClose = (p: WorkoutPlan) => {
    setPlan(p);
    savePlan(p);
  };

  // Run DFA self-test once in dev (verifiable via console).
  useEffect(() => {
    if (import.meta.env.DEV) selfTestDFA();
  }, []);

  // Current race segment derived from the elapsed schedule (pacing guide).
  const cum = useMemo(() => {
    const arr: number[] = [];
    let acc = 0;
    for (const s of segments) {
      acc += s.plannedSec;
      arr.push(acc);
    }
    return arr;
  }, [segments]);

  const currentIndex = useMemo(() => {
    if (eng.mode === "idle") return 0;
    const e = snap.elapsedSec;
    for (let i = 0; i < cum.length; i++) if (e < cum[i]) return i;
    return segments.length - 1;
  }, [snap.elapsedSec, eng.mode, cum, segments.length]);

  const records = useMemo(
    () => computeSegmentRecords(series, segments, currentIndex),
    [series, segments, currentIndex]
  );

  const focusIndex = manualFocus ?? currentIndex;
  const isFocusCurrent = focusIndex === currentIndex;
  const focusSeg = segments[focusIndex];

  // ---- HYROX segment-end countdown + voice -------------------------------
  const hyroxRemaining = useMemo(() => {
    if (raceMode !== "hyrox" || eng.mode === "idle") return null;
    const end = cum[currentIndex];
    const r = end - snap.elapsedSec;
    return r > 0 && r <= 60 ? r : null;
  }, [raceMode, eng.mode, cum, currentIndex, snap.elapsedSec]);

  useEffect(() => {
    if (hyroxRemaining == null) return;
    const n = Math.ceil(hyroxRemaining);
    if (n >= 1 && n <= 3) {
      const token = `hx:${currentIndex}:${n}`;
      if (!hyroxFired.current.has(token)) {
        hyroxFired.current.add(token);
        hyroxCoach.current.say(String(n));
        hyroxCoach.current.beep(n === 1 ? 660 : 760, 90);
        if (n === 1) {
          const next = segments[currentIndex + 1];
          if (next) hyroxCoach.current.say(`Next, ${next.label}.`);
        }
      }
    }
  }, [hyroxRemaining, currentIndex, segments]);

  // Unified huge-countdown driver for the overlay.
  const countdown = useMemo<{ seconds: number | null; label?: string }>(() => {
    if (raceMode === "workout" && runner.state.phase === "running") {
      const n = Math.ceil(runner.state.remainingSec);
      if (n >= 1 && n <= 3) {
        return { seconds: n, label: runner.state.nextInterval ? `→ ${runner.state.nextInterval.name}` : "Final interval" };
      }
    }
    if (raceMode === "hyrox" && hyroxRemaining != null) {
      const n = Math.ceil(hyroxRemaining);
      if (n >= 1 && n <= 3) {
        const next = segments[currentIndex + 1];
        return { seconds: n, label: next ? `→ ${next.label}` : "Finish line" };
      }
    }
    return { seconds: null };
  }, [raceMode, runner.state, hyroxRemaining, segments, currentIndex]);

  // Reset transient race UI when a session ends/resets.
  useEffect(() => {
    if (eng.mode === "idle") setManualFocus(null);
  }, [eng.mode]);

  const handleStop = () => {
    const workoutSegs =
      raceMode === "workout" && plan && workoutAnchor != null
        ? workoutSegmentRecords(plan, workoutAnchor, voice.leadInSec, runner.state.perInterval, snap.t)
        : [];
    const s = buildSummary(snap, series, raceMode, segments, currentIndex, records, {
      adherencePct: runner.state.adherencePct,
      planTitle: plan?.title,
      segments: workoutSegs,
    });
    fullSeriesRef.current = [...series];
    eng.stop();
    clearAnchor();
    // Persist to history only if the session had real activity.
    if (s.durationSec >= 5 && (s.avgHr != null || s.distanceM > 0)) {
      addToHistory(s);
      setHistory(loadHistory());
    }
    setSummary(s);
  };

  return (
    <div className="min-h-screen">
      <div className="ambient" />

      <TopBar
        snap={snap}
        device={eng.device}
        mode={eng.mode}
        raceMode={raceMode}
        onRaceModeChange={handleModeChange}
        onConnect={handleConnect}
        onDemo={handleDemo}
        onStop={handleStop}
        onSettings={() => setSettingsOpen(true)}
        onHistory={() => setHistoryOpen(true)}
        supported={eng.supported}
      />

      <main className="max-w-[1480px] mx-auto px-4 sm:px-6 py-5 space-y-4">
        {eng.error && (
          <div className="card px-4 py-3 text-sm flex items-center gap-3" style={{ borderColor: "rgba(255,176,46,0.4)" }}>
            <span className="text-[var(--color-amber)]">⚠</span>
            <span className="text-[var(--color-ink-dim)]">{eng.error}</span>
          </div>
        )}

        {eng.mode === "idle" && !summary && raceMode !== "workout" && (
          <WelcomeBanner onDemo={handleDemo} onConnect={handleConnect} supported={eng.supported} />
        )}

        {/* Hero row */}
        <motion.div layout className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-3"><HeroHR snap={snap} profile={profile} /></div>
          <div className="lg:col-span-3"><DfaGauge snap={snap} /></div>
          <div className="lg:col-span-6">
            {raceMode === "hyrox" ? (
              <div className="flex flex-col gap-4 h-full">
                {focusSeg && <StationGuide seg={focusSeg} profile={profile} isCurrent={isFocusCurrent && eng.mode !== "idle"} />}
              </div>
            ) : raceMode === "workout" ? (
              plan ? (
                <GuidedRun
                  state={runner.state}
                  plan={plan}
                  profile={profile}
                  hr={snap.hr}
                  sourceLive={eng.mode !== "idle"}
                  simulated={eng.mode === "demo"}
                  onStart={handleStartWorkout}
                  onConnect={handleConnect}
                  onSimulate={handleDemo}
                  onEdit={() => setBuilderOpen(true)}
                />
              ) : (
                <WorkoutEmpty onBuild={() => setBuilderOpen(true)} />
              )
            ) : (
              <InsightPanel snap={snap} />
            )}
          </div>
        </motion.div>

        {/* Live telemetry chart */}
        <LiveChart series={series} bounds={snap.zoneBounds} maxHr={profile.maxHr} />

        {/* Metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
          <DecouplingCard snap={snap} />
          <HrvCard snap={snap} series={series} />
          <BreathingCard snap={snap} />
          <PaceCard snap={snap} />
          <IntervalCard snap={snap} />
        </div>

        {/* HYROX race rail */}
        {raceMode === "hyrox" && (
          <RaceRail
            segments={segments}
            currentIndex={currentIndex}
            focusIndex={focusIndex}
            records={records}
            profile={profile}
            onFocus={setManualFocus}
          />
        )}

        {/* Workout interval rail */}
        {raceMode === "workout" && plan && (
          <WorkoutRail plan={plan} state={runner.state} profile={profile} />
        )}

        {/* Zone distribution */}
        <ZoneBars snap={snap} />

        <Footer />
      </main>

      <WorkoutBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        initialPlan={plan}
        profile={profile}
        voice={voice}
        onVoiceChange={persistVoice}
        apiKey={apiKey}
        onApiKeyChange={persistApiKey}
        model={visionModel}
        onModelChange={persistModel}
        onSave={savePlanAndClose}
        onStart={adoptWorkout}
      />
      <SettingsDrawer
        open={settingsOpen}
        profile={profile}
        apiKey={apiKey}
        onApiKeyChange={persistApiKey}
        model={visionModel}
        onModelChange={persistModel}
        onClose={() => setSettingsOpen(false)}
        onSave={eng.setProfile}
      />
      {/* Live post-session summary (resets the engine on close). */}
      <SummaryModal
        summary={summary}
        fullSeries={fullSeriesRef.current}
        onClose={() => {
          setSummary(null);
          eng.reset();
        }}
      />

      {/* Read-only detail of a past session from history. */}
      <SummaryModal
        summary={historyDetail}
        fullSeries={historyDetail?.series ?? []}
        onClose={() => setHistoryDetail(null)}
      />

      <HistoryModal
        open={historyOpen}
        sessions={history}
        onClose={() => setHistoryOpen(false)}
        onOpen={(s) => setHistoryDetail(s)}
        onDelete={(id) => setHistory(deleteFromHistory(id))}
        onClear={() => setHistory(clearHistory())}
      />

      {/* Huge 3-2-1 countdown for the end of the current interval / segment. */}
      <CountdownOverlay seconds={countdown.seconds} label={countdown.label} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function WelcomeBanner({ onDemo, onConnect, supported }: { onDemo: () => void; onConnect: () => void; supported: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card p-6 sm:p-8 relative overflow-hidden">
      <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ background: "radial-gradient(600px 300px at 100% 0%, rgba(216,255,58,0.25), transparent 60%)" }} />
      <div className="relative max-w-2xl">
        <div className="inline-flex items-center gap-2 text-[11px] mono text-[var(--color-volt)] mb-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-volt)]" /> REAL-TIME MULTI-SENSOR ANALYZER
        </div>
        <h1 className="font-[var(--font-display)] text-3xl sm:text-4xl font-bold leading-tight">
          Read your engine in real time.
        </h1>
        <p className="text-[var(--color-ink-dim)] mt-3 leading-relaxed">
          RoxLive turns a Bluetooth heart-rate strap into a sports-science lab — live <span className="text-[var(--color-cyan)]">DFA-α1</span> thresholds,
          aerobic decoupling, RSA breathing rate, HR-zone segmentation and a full HYROX race guide. Pair a Polar H10 / Garmin
          HRM-Pro for real metrics, or <span className="text-[var(--color-volt)]">simulate</span> to explore it with no hardware.
        </p>
        <div className="flex flex-wrap gap-3 mt-5">
          <button onClick={onConnect} className="btn-volt px-6 h-11 text-sm">Connect HR Sensor</button>
          <button onClick={onDemo} className="btn-ghost px-6 h-11 text-sm">▶ Simulate</button>
        </div>
        {!supported && (
          <p className="text-[11px] text-[var(--color-ink-faint)] mt-3">
            Live pairing needs Web Bluetooth (Chrome / Edge on desktop or Android). The simulator works everywhere.
          </p>
        )}
      </div>
    </motion.div>
  );
}

function WorkoutEmpty({ onBuild }: { onBuild: () => void }) {
  return (
    <div className="card p-6 h-full grid place-items-center text-center relative overflow-hidden">
      <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ background: "radial-gradient(500px 240px at 50% 0%, rgba(216,255,58,0.2), transparent 60%)" }} />
      <div className="relative">
        <div className="text-3xl mb-2">📋</div>
        <h3 className="font-[var(--font-display)] text-xl font-bold">Load today's workout</h3>
        <p className="text-[13px] text-[var(--color-ink-dim)] mt-2 max-w-sm">
          Snap a photo of your plan and let Claude turn it into timed intervals with target zones — or pick a sample and tune the voice coach.
        </p>
        <button onClick={onBuild} className="btn-volt px-5 h-10 text-sm mt-4">Build / import workout</button>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="pt-2 pb-8 text-center">
      <p className="text-[11px] text-[var(--color-ink-faint)] leading-relaxed max-w-2xl mx-auto">
        Built on the Web Bluetooth Heart Rate Service (0x180D). DFA-α1 thresholds (0.75 ≈ LT1, 0.50 ≈ LT2) are population
        defaults — validate against your own lactate/ramp test. Not a medical device.
      </p>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Session analytics helpers                                          */
/* ------------------------------------------------------------------ */

function computeSegmentRecords(
  series: SeriesPoint[],
  segments: PlannedSegment[],
  currentIndex: number
): Record<number, SegmentRecord> {
  const out: Record<number, SegmentRecord> = {};
  if (series.length === 0) return out;
  const start = series[0].t;

  const bounds: [number, number][] = [];
  let acc = 0;
  for (const s of segments) {
    bounds.push([acc, acc + s.plannedSec]);
    acc += s.plannedSec;
  }

  type Bucket = { hrs: number[]; alphas: number[]; t0: number | null; t1: number | null; dist: number };
  const buckets: Bucket[] = segments.map(() => ({ hrs: [], alphas: [], t0: null, t1: null, dist: 0 }));

  for (const p of series) {
    const e = (p.t - start) / 1000;
    let idx = bounds.findIndex((b) => e >= b[0] && e < b[1]);
    if (idx < 0) idx = e >= acc ? segments.length - 1 : 0;
    const b = buckets[idx];
    if (p.hr != null) b.hrs.push(p.hr);
    if (p.alpha1 != null) b.alphas.push(p.alpha1);
    if (b.t0 === null) b.t0 = p.t;
    b.t1 = p.t;
  }

  buckets.forEach((b, i) => {
    if (b.t0 === null || (i > currentIndex && b.hrs.length === 0)) return;
    if (b.hrs.length === 0 && b.alphas.length === 0) return;
    out[i] = {
      index: i,
      kind: segments[i].kind,
      label: segments[i].label,
      startT: b.t0,
      endT: b.t1,
      splitSec: b.t0 !== null && b.t1 !== null ? (b.t1 - b.t0) / 1000 : null,
      avgHr: b.hrs.length ? avg(b.hrs) : null,
      maxHr: b.hrs.length ? Math.max(...b.hrs) : null,
      avgAlpha1: b.alphas.length ? avg(b.alphas) : null,
      distanceM: 0,
    };
  });
  return out;
}

function buildSummary(
  snap: ReturnType<typeof useEngine>["snapshot"],
  series: SeriesPoint[],
  raceMode: "free" | "hyrox" | "workout",
  segments: PlannedSegment[],
  currentIndex: number,
  records: Record<number, SegmentRecord>,
  workout: { adherencePct: number | null; planTitle?: string; segments: SegmentRecord[] }
): SessionSummary {
  const alphas = series.map((p) => p.alpha1).filter((v): v is number => v != null);
  const brs = series.map((p) => p.brpm).filter((v): v is number => v != null);

  // downsample ~1 point / 5s
  const ds: SeriesPoint[] = series.filter((_, i) => i % 5 === 0);

  const segArr =
    raceMode === "hyrox"
      ? segments.slice(0, currentIndex + 1).map((s) => records[s.index]).filter(Boolean)
      : raceMode === "workout"
        ? workout.segments
        : [];

  return {
    id: `s-${Math.round(snap.t)}`,
    startedAt: snap.t - snap.elapsedSec * 1000,
    endedAt: snap.t,
    durationSec: snap.elapsedSec,
    mode: raceMode,
    adherencePct: raceMode === "workout" ? workout.adherencePct : null,
    planTitle: raceMode === "workout" ? workout.planTitle : undefined,
    avgHr: snap.hrAvg,
    maxHr: snap.hrMax,
    distanceM: snap.distanceM,
    kcal: snap.kcal,
    zoneTimeSec: snap.zoneTimeSec,
    decouplingPct: snap.decoupling.pct,
    minAlpha1: alphas.length ? Math.min(...alphas) : null,
    avgBrpm: brs.length ? avg(brs) : null,
    intervalCount: snap.intervalCount,
    segments: segArr,
    series: ds,
  };
}

/** Synthesize per-interval lap records for a guided workout (for summary + FIT). */
function workoutSegmentRecords(
  plan: WorkoutPlan,
  anchorMs: number,
  leadInSec: number,
  per: { index: number; avgHr: number | null }[],
  stopMs: number
): SegmentRecord[] {
  const out: SegmentRecord[] = [];
  let startMs = anchorMs + leadInSec * 1000;
  plan.intervals.forEach((iv, i) => {
    if (startMs >= stopMs) return;
    const endMs = Math.min(startMs + iv.durationSec * 1000, stopMs);
    out.push({
      index: i,
      kind: iv.kind === "work" ? "run" : "station",
      label: iv.name,
      startT: startMs,
      endT: endMs,
      splitSec: (endMs - startMs) / 1000,
      avgHr: per.find((p) => p.index === i)?.avgHr ?? null,
      maxHr: null,
      avgAlpha1: null,
      distanceM: 0,
    });
    startMs += iv.durationSec * 1000;
  });
  return out;
}

/** Build the simulator's HR-target function for a workout plan. */
function planTargetHr(plan: WorkoutPlan, leadInSec: number, profile: AthleteProfile) {
  const ends = cumulativeEnds(plan);
  const KIND_PCT: Record<string, number> = { warmup: 0.6, work: 0.85, active: 0.72, rest: 0.6, cooldown: 0.55 };
  return (elapsedSec: number): number | null => {
    if (elapsedSec < leadInSec) return null; // warm up
    const t = elapsedSec - leadInSec;
    let idx = ends.findIndex((e) => t < e);
    if (idx < 0) idx = plan.intervals.length - 1;
    const iv = plan.intervals[idx];
    const band = resolveBand(iv.target, profile);
    if (band) return (band.low + band.high) / 2;
    return profile.maxHr * (KIND_PCT[iv.kind] ?? 0.7);
  };
}

function loadVoice(): VoiceSettings {
  try {
    const raw = localStorage.getItem("roxlive.voice");
    if (raw) return { ...DEFAULT_VOICE, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_VOICE;
}

function avg(arr: number[]): number {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
