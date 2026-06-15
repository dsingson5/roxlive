import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useEngine } from "./hooks/useEngine";
import { useWorkoutRunner } from "./hooks/useWorkoutRunner";
import { useSquad, MAX_ATHLETES } from "./hooks/useSquad";
import { usePiP, type PaintFn } from "./hooks/usePiP";
import { paintFrame, ZONE_HEX, type PipFrame } from "./lib/pipPaint";
import { fmtClock } from "./lib/format";
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
import { SINGLE_MODALITIES, guessModality, type Modality } from "./lib/modality";
import { buildRace } from "./data/hyrox";
import { selfTestDFA } from "./lib/dfa";
import { cumulativeEnds, loadPlan, resolveBand, samplePlans, savePlan } from "./lib/workout";
import { VISION_MODELS } from "./lib/vision";
import { VoiceCoach } from "./lib/voice";
import { addToHistory, clearHistory, deleteFromHistory, loadHistory, pullAndMerge, updateHistory } from "./lib/history";
import { resolveCrewUser, prettyUser } from "./lib/user";
import {
  loadSyncConfig,
  saveSyncConfig,
  isSyncConfigured,
  flushPendingPushes,
  login as syncLogin,
  changePassword as syncChangePassword,
  clearSession,
  sessionUser,
  isAdminUser,
  type SyncConfig,
} from "./lib/sync";
import { logActivity, flushActivity } from "./lib/activity";
import { AdminPanel } from "./components/AdminPanel";
import * as strava from "./lib/strava";
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
import { SquadView } from "./components/SquadView";

export default function App() {
  const eng = useEngine();
  const { snapshot: snap, series, profile } = eng;

  const [raceMode, setRaceMode] = useState<"free" | "hyrox" | "workout" | "squad">("free");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [manualFocus, setManualFocus] = useState<number | null>(null);

  // Signed-in Hybrid Crew athlete (same-origin hub) — scopes saved history.
  const crewUser = useMemo(() => resolveCrewUser(), []);

  // Workout history (persisted locally, per crew user when signed in).
  const [history, setHistory] = useState<SessionSummary[]>(() => loadHistory());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<SessionSummary | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);

  // Cross-device sync: a signed-in athlete's history follows them to any device.
  // Auth is a real password (server-verified) → a signed session token.
  const [syncCfg, setSyncCfg] = useState<SyncConfig>(() => loadSyncConfig());
  const [syncBusy, setSyncBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(() => !!crewUser && sessionUser() === crewUser);
  const [mustChangePw, setMustChangePw] = useState(false);
  const syncNow = useCallback(async () => {
    if (!crewUser || !isSyncConfigured() || sessionUser() !== crewUser) return;
    setSyncBusy(true);
    try {
      setHistory(await pullAndMerge()); // pull → union+tombstones → persist + push back
    } finally {
      setSyncBusy(false);
    }
  }, [crewUser]);
  const handleLogin = useCallback(
    async (password: string) => {
      if (!crewUser) return { ok: false, error: "no athlete signed in" };
      const r = await syncLogin(crewUser, password);
      if (r.ok) {
        setSignedIn(true);
        setMustChangePw(!!r.mustChange);
        syncNow();
      }
      return r;
    },
    [crewUser, syncNow]
  );
  const handleChangePassword = useCallback(
    async (current: string, next: string) => {
      if (!crewUser) return { ok: false, error: "no athlete signed in" };
      const r = await syncChangePassword(crewUser, current, next);
      if (r.ok) {
        setSignedIn(true);
        setMustChangePw(false);
      }
      return r;
    },
    [crewUser]
  );
  const handleLogout = useCallback(() => {
    clearSession();
    // Also drop the bound identity so a shared device doesn't keep showing the
    // previous athlete's cached history/name; reload for a clean slate.
    try {
      localStorage.removeItem("hcUser");
      sessionStorage.removeItem("hcUser");
      localStorage.removeItem("roxlive.user");
    } catch {
      /* ignore */
    }
    window.location.reload();
  }, []);
  // Pull on load (once the athlete is known + a session exists); note the visit.
  useEffect(() => {
    syncNow();
    if (sessionUser()) logActivity("open");
  }, [syncNow]);
  // Flush debounced cloud push + activity before the tab is backgrounded/closed.
  useEffect(() => {
    const flush = () => { flushPendingPushes(); flushActivity(); };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Strava
  const [stravaCfg, setStravaCfg] = useState(() => strava.loadConfig());
  const [stravaConnected, setStravaConnected] = useState(() => strava.isConnected());
  const [stravaAthlete, setStravaAthlete] = useState<string | null>(() => strava.connectedAthlete());
  const [notice, setNotice] = useState<string | null>(null);

  // Complete a Strava OAuth redirect if we came back with a ?code.
  useEffect(() => {
    strava.handleRedirectIfPresent().then((res) => {
      if (!res) return;
      if (res.status === "connected") {
        setStravaConnected(true);
        setStravaAthlete(strava.connectedAthlete());
        setNotice("Strava connected ✓");
      } else {
        setNotice(res.message || "Strava connection failed.");
      }
    });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const saveStravaCfg = (c: strava.StravaConfig) => {
    strava.saveConfig(c);
    setStravaCfg(strava.loadConfig());
  };
  const disconnectStrava = () => {
    strava.disconnect();
    setStravaConnected(false);
    setStravaAthlete(null);
  };

  // Workout-mode state (persisted locally).
  const [plan, setPlan] = useState<WorkoutPlan | null>(() => loadPlan());
  const [freeModality, setFreeModality] = useState<Modality>(() => {
    const stored = localStorage.getItem("roxlive.freeModality");
    // only accept a real single-sport id (never "mixed" or garbage)
    return SINGLE_MODALITIES.some((m) => m.id === stored) ? (stored as Modality) : "run";
  });
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

  // Workout pause: freezes the plan clock (countdown, cues, adherence) while the
  // engine keeps recording HR. pausedAt = when paused; pauseAccum = total paused ms.
  const [paused, setPaused] = useState(false);
  const pausedAtRef = useRef<number | null>(null);
  const pauseAccumRef = useRef(0);

  /** Plan elapsed seconds, pause-adjusted. `clockNow` lets callers pass snap.t. */
  const planElapsed = (clockNow: number): number => {
    if (anchorRef.current == null) return 0;
    const effNow = pausedAtRef.current ?? clockNow;
    return Math.max(0, (effNow - anchorRef.current - pauseAccumRef.current) / 1000);
  };

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
  // Pause-aware so the sim holds the current interval's target while paused.
  const simTargetFn = useCallback((_simElapsedSec: number): number | null => {
    if (anchorRef.current == null || !planFnRef.current) return null;
    return planFnRef.current(planElapsed(performance.timeOrigin + performance.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Multi-athlete squad (its own engines; independent of the solo session).
  const squad = useSquad(voice, profile);
  // HYROX as an assignable squad plan (the race as timed, classified intervals).
  const hyroxPlan = useMemo<WorkoutPlan>(
    () => ({
      id: "hyrox-race",
      title: "HYROX Race",
      source: "sample",
      createdAt: 0,
      modality: "mixed",
      intervals: segments.map((s) => ({
        id: `hx-${s.index}`,
        name: s.label,
        kind: "work" as const,
        durationSec: s.plannedSec,
        target: { type: "none" as const },
        modality: s.kind === "run" ? ("run" as Modality) : guessModality(s.label),
      })),
    }),
    [segments]
  );
  const squadPlans = useMemo(() => {
    const list: WorkoutPlan[] = [hyroxPlan];
    if (plan) list.push(plan);
    for (const s of samplePlans()) list.push(s);
    return list;
  }, [plan, hyroxPlan]);

  const workoutActive =
    raceMode === "workout" && eng.mode !== "idle" && !!plan && workoutAnchor != null;
  const runner = useWorkoutRunner({
    plan,
    profile,
    voice,
    active: workoutActive,
    elapsedSec: planElapsed(snap.t),
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
  const persistFreeModality = (m: Modality) => {
    setFreeModality(m);
    try {
      localStorage.setItem("roxlive.freeModality", m);
    } catch {
      /* ignore */
    }
  };

  const clearAnchor = () => {
    anchorRef.current = null;
    setWorkoutAnchor(null);
    pausedAtRef.current = null;
    pauseAccumRef.current = 0;
    setPaused(false);
  };

  const togglePause = () => {
    if (anchorRef.current == null) return;
    const t = performance.timeOrigin + performance.now();
    if (pausedAtRef.current == null) {
      pausedAtRef.current = t; // pause: freeze the plan clock
      runner.coach.cancel(); // stop any in-flight countdown speech
      setPaused(true);
    } else {
      pauseAccumRef.current += t - pausedAtRef.current; // resume: absorb paused span
      pausedAtRef.current = null;
      setPaused(false);
    }
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
    logActivity("workout_start", plan.title);
    runner.coach.prime(); // user gesture: unlock speech synthesis + audio
    const t = performance.timeOrigin + performance.now();
    pausedAtRef.current = null;
    pauseAccumRef.current = 0;
    setPaused(false);
    anchorRef.current = t;
    setWorkoutAnchor(t);
  };

  const handleModeChange = (m: "free" | "hyrox" | "workout" | "squad") => {
    if (m !== raceMode) logActivity("mode", m);
    const leavingSquad = raceMode === "squad" && m !== "squad";
    if (leavingSquad) squad.stopAll();
    if (m === "squad" && eng.mode !== "idle") eng.stop(); // free the solo session
    setRaceMode(m);
    hyroxFired.current = new Set(); // avoid stale countdown tokens across modes
    if (m !== "workout") clearAnchor();
  };

  // Top-level section: the workout sub-type (free / plan / hyrox) is chosen inside.
  const [workoutType, setWorkoutType] = useState<"free" | "workout" | "hyrox">("free");
  const chooseWorkoutType = (t: "free" | "workout" | "hyrox") => {
    setWorkoutType(t);
    handleModeChange(t);
    if (t === "workout" && !plan) setBuilderOpen(true);
  };
  const handleSectionChange = (s: "workout" | "squad") => {
    if (s === "squad") handleModeChange("squad");
    else chooseWorkoutType(workoutType);
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

  // ---- Picture-in-Picture mini window ----
  const paintRef = useRef<PaintFn>(() => {});
  const pip = usePiP(paintRef);
  const buildPipFrame = (): PipFrame => {
    if (raceMode === "squad") {
      const athletes = squad.athletes
        .map((a) => {
          const s = squad.snapshots[a.id];
          const v = squad.views[a.id];
          const sub =
            v && v.phase === "running" && v.interval
              ? `${v.interval.name} ${fmtClock(Math.ceil(v.remainingSec))}`
              : v && v.phase === "leadin"
                ? "starting…"
                : v && v.phase === "done"
                  ? "done"
                  : s?.hr != null
                    ? "live"
                    : "";
          return { name: a.name, hr: s?.hr ?? null, color: a.color, sub, paused: !!squad.pausedIds[a.id] };
        })
        .filter((a) => a.hr != null || a.sub);
      return { title: "Squad", mode: "squad", athletes };
    }
    const zoneColor = snap.hr != null && snap.zone ? ZONE_HEX[snap.zone - 1] : "#5d6675";
    let line1: string | undefined;
    let line2: string | undefined;
    let status: string | undefined;
    let statusColor: string | undefined;
    if (raceMode === "workout" && runner.state.phase === "running" && runner.state.interval) {
      line1 = runner.state.interval.name;
      line2 = fmtClock(Math.ceil(runner.state.remainingSec));
      const st = runner.state.hrStatus;
      if (st === "in") { status = "ON TARGET"; statusColor = "#3dffb5"; }
      else if (st === "under") { status = "PUSH"; statusColor = "#38e1ff"; }
      else if (st === "over") { status = "EASE"; statusColor = "#ffb02e"; }
    } else if (raceMode === "hyrox") {
      line1 = segments[currentIndex]?.label;
      if (hyroxRemaining != null) line2 = fmtClock(Math.ceil(hyroxRemaining));
    }
    return {
      title: raceMode === "workout" && plan ? plan.title : raceMode === "hyrox" ? "HYROX" : "Analyzer",
      mode: "solo",
      hr: snap.hr,
      zoneColor,
      pctMax: snap.pctMax,
      line1,
      line2,
      status,
      statusColor,
      paused,
    };
  };
  paintRef.current = (ctx, w, h) => paintFrame(ctx, w, h, buildPipFrame());

  const handleStop = () => {
    if (raceMode === "squad") return; // squad has its own lifecycle
    const workoutSegs =
      raceMode === "workout" && plan && workoutAnchor != null
        ? workoutSegmentRecords(plan, workoutAnchor, voice.leadInSec, runner.state.perInterval, snap.t)
        : [];
    const sessionModality: Modality =
      raceMode === "hyrox" ? "mixed" : raceMode === "workout" ? plan?.modality ?? "mixed" : freeModality;
    const s = buildSummary(
      snap,
      series,
      raceMode,
      segments,
      currentIndex,
      records,
      {
        adherencePct: runner.state.adherencePct,
        planTitle: plan?.title,
        segments: workoutSegs,
      },
      sessionModality
    );
    fullSeriesRef.current = [...series];
    eng.stop();
    clearAnchor();
    // Persist to history only if the session had real activity.
    if (s.durationSec >= 5 && (s.avgHr != null || s.distanceM > 0)) {
      addToHistory(s);
      setHistory(loadHistory());
      logActivity("workout_done", `${s.modality ?? s.mode} · ${Math.round(s.durationSec / 60)}m`);
    }
    setSummary(s);
  };

  // Start/Pause/Stop controls ON the floating PiP window via the Media Session
  // API — these render as the play/pause/stop buttons on the PiP overlay
  // (desktop + mobile) and drive the workout, not the video stream.
  useEffect(() => {
    if (!pip.active || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const frame = buildPipFrame();
    try {
      ms.metadata = new MediaMetadata({
        title: frame.title || "RoxLive",
        artist: [frame.line1, frame.line2].filter(Boolean).join(" · ") || "RoxLive",
      });
    } catch {
      /* MediaMetadata unsupported */
    }
    try {
      ms.playbackState = paused ? "paused" : "playing";
    } catch {
      /* ignore */
    }
    const canStart = raceMode === "workout" && eng.mode !== "idle" && workoutAnchor == null && !!plan;
    const set = (action: MediaSessionAction, fn: (() => void) | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* action unsupported on this browser */
      }
    };
    set("play", () => {
      if (paused) togglePause();
      else if (canStart) handleStartWorkout();
    });
    set("pause", () => {
      if (raceMode === "workout" && workoutAnchor != null && !paused) togglePause();
    });
    set("stop", () => {
      if (raceMode === "squad") squad.stopAll();
      else if (eng.mode !== "idle") handleStop();
    });
    return () => {
      (["play", "pause", "stop"] as MediaSessionAction[]).forEach((a) => set(a, null));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pip.active, paused, raceMode, eng.mode, workoutAnchor, plan]);

  return (
    <div className="min-h-screen">
      <div className="ambient" />

      <TopBar
        snap={snap}
        device={eng.device}
        mode={eng.mode}
        raceMode={raceMode}
        onSectionChange={handleSectionChange}
        onConnect={handleConnect}
        onDemo={handleDemo}
        onStop={handleStop}
        onSettings={() => setSettingsOpen(true)}
        onHistory={() => { setHistory(loadHistory()); setHistoryOpen(true); syncNow(); logActivity("history_view"); }}
        onAdmin={isAdminUser(crewUser) && signedIn ? () => setAdminOpen(true) : undefined}
        onPiP={pip.toggle}
        pipActive={pip.active}
        pipSupported={pip.supported}
        supported={eng.supported}
      />

      <main className="max-w-[1480px] mx-auto px-4 sm:px-6 py-3 space-y-3">
        {notice && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="card px-4 py-3 text-sm flex items-center gap-3" style={{ borderColor: "rgba(252,76,2,0.4)" }}>
            <span className="text-[#fc4c02]">●</span>
            <span className="text-[var(--color-ink-dim)]">{notice}</span>
          </motion.div>
        )}
        {eng.error && (
          <div className="card px-4 py-3 text-sm flex items-center gap-3" style={{ borderColor: "rgba(255,176,46,0.4)" }}>
            <span className="text-[var(--color-amber)]">⚠</span>
            <span className="text-[var(--color-ink-dim)]">{eng.error}</span>
          </div>
        )}

        {raceMode === "squad" ? (
          <SquadView
            athletes={squad.athletes}
            snapshots={squad.snapshots}
            views={squad.views}
            adherence={squad.adherence}
            running={squad.running}
            pausedIds={squad.pausedIds}
            plans={squadPlans}
            supported={squad.supported}
            max={MAX_ATHLETES}
            h={{
              addAthlete: squad.addAthlete,
              removeAthlete: squad.removeAthlete,
              setName: squad.setName,
              setMaxHr: squad.setMaxHr,
              setPlan: squad.setPlan,
              startSim: squad.startSim,
              connectSensor: squad.connectSensor,
              startPlan: squad.startPlan,
              startAll: squad.startAll,
              stopAll: squad.stopAll,
              pauseAthlete: squad.pauseAthlete,
              logRpe: (id, rpe) => {
                squad.logAthleteRpe(id, rpe);
                // squad RPE is persisted inside the hook; refresh the in-memory
                // list so an already-open History modal reflects it immediately.
                setHistory(loadHistory());
              },
            }}
          />
        ) : (
        eng.mode === "idle" && !summary ? (
          /* ---- Setup (compact — fits one screen) ---- */
          <>
            <SessionSetup
              raceMode={raceMode}
              onType={chooseWorkoutType}
              plan={plan}
              onBuild={() => setBuilderOpen(true)}
              freeModality={freeModality}
              onFreeModality={persistFreeModality}
            />
            {raceMode === "workout" && plan && <WorkoutRail plan={plan} state={runner.state} profile={profile} />}
            {raceMode === "hyrox" && (
              <RaceRail segments={segments} currentIndex={currentIndex} focusIndex={focusIndex} records={records} profile={profile} onFocus={setManualFocus} />
            )}
          </>
        ) : (
          /* ---- Live dashboard ---- */
          <>
            <motion.div layout className="grid grid-cols-1 lg:grid-cols-12 gap-3">
              <div className="lg:col-span-3"><HeroHR snap={snap} profile={profile} /></div>
              <div className="lg:col-span-3"><DfaGauge snap={snap} /></div>
              <div className="lg:col-span-6">
                {raceMode === "hyrox" ? (
                  <div className="flex flex-col gap-3 h-full">
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
                      paused={paused}
                      onStart={handleStartWorkout}
                      onPause={togglePause}
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

            <LiveChart series={series} bounds={snap.zoneBounds} maxHr={profile.maxHr} />

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              <DecouplingCard snap={snap} />
              <HrvCard snap={snap} series={series} />
              <BreathingCard snap={snap} />
              <PaceCard snap={snap} />
              <IntervalCard snap={snap} />
            </div>

            {raceMode === "hyrox" && (
              <RaceRail segments={segments} currentIndex={currentIndex} focusIndex={focusIndex} records={records} profile={profile} onFocus={setManualFocus} />
            )}
            {raceMode === "workout" && plan && <WorkoutRail plan={plan} state={runner.state} profile={profile} />}

            <ZoneBars snap={snap} />
          </>
        )
        )}

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
        strava={{
          config: stravaCfg,
          connected: stravaConnected,
          athlete: stravaAthlete,
          onSaveConfig: saveStravaCfg,
          onConnect: strava.beginAuthorize,
          onDisconnect: disconnectStrava,
        }}
        sync={{
          config: syncCfg,
          user: prettyUser(crewUser),
          hasUser: !!crewUser,
          signedIn,
          mustChange: mustChangePw,
          busy: syncBusy,
          onLogin: handleLogin,
          onChangePassword: handleChangePassword,
          onLogout: handleLogout,
          onSyncNow: syncNow,
          onSaveUrl: (url) => { saveSyncConfig({ url }); setSyncCfg(loadSyncConfig()); },
        }}
        onClose={() => setSettingsOpen(false)}
        onSave={eng.setProfile}
      />
      {/* Live post-session summary (resets the engine on close). */}
      <SummaryModal
        summary={summary}
        fullSeries={fullSeriesRef.current}
        strava={{ connected: stravaConnected, post: strava.postActivity }}
        onRpe={(rpe) => {
          if (!summary) return;
          setSummary({ ...summary, rpe });
          setHistory(updateHistory(summary.id, { rpe }));
        }}
        onClose={() => {
          setSummary(null);
          eng.reset();
        }}
      />

      {/* Read-only detail of a past session from history. */}
      <SummaryModal
        summary={historyDetail}
        fullSeries={historyDetail?.series ?? []}
        strava={{ connected: stravaConnected, post: strava.postActivity }}
        onRpe={(rpe) => {
          if (!historyDetail) return;
          setHistoryDetail({ ...historyDetail, rpe });
          setHistory(updateHistory(historyDetail.id, { rpe }));
        }}
        onClose={() => setHistoryDetail(null)}
      />

      <HistoryModal
        open={historyOpen}
        sessions={history}
        userLabel={prettyUser(crewUser)}
        synced={signedIn}
        onClose={() => setHistoryOpen(false)}
        onOpen={(s) => setHistoryDetail(s)}
        onDelete={(id) => setHistory(deleteFromHistory(id))}
        onClear={() => setHistory(clearHistory())}
      />

      {/* Coach-only crew dashboard (david). */}
      <AdminPanel open={adminOpen} profile={profile} onClose={() => setAdminOpen(false)} />

      {/* Huge 3-2-1 countdown for the end of the current interval / segment. */}
      <CountdownOverlay seconds={countdown.seconds} label={countdown.label} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Idle setup card: choose the workout type (Free / Plan / HYROX) and classify
 *  before starting. Start buttons live in the TopBar (Connect / Simulate). */
function SessionSetup({
  raceMode,
  onType,
  plan,
  onBuild,
  freeModality,
  onFreeModality,
}: {
  raceMode: "free" | "hyrox" | "workout" | "squad";
  onType: (t: "free" | "workout" | "hyrox") => void;
  plan: WorkoutPlan | null;
  onBuild: () => void;
  freeModality: Modality;
  onFreeModality: (m: Modality) => void;
}) {
  const types = [
    { id: "free", label: "Free" },
    { id: "workout", label: "Plan" },
    { id: "hyrox", label: "HYROX" },
  ] as const;
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card p-3 sm:p-4">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <div className="flex bg-white/[0.04] rounded-xl p-0.5 border border-[var(--color-line)]">
          {types.map((t) => (
            <button
              key={t.id}
              onClick={() => onType(t.id)}
              className="px-4 h-8 rounded-lg text-[13px] font-semibold transition-colors"
              style={{ background: raceMode === t.id ? "var(--color-volt)" : "transparent", color: raceMode === t.id ? "#0b0c06" : "var(--color-ink-dim)" }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-[var(--color-ink-faint)]">
          {raceMode === "free" ? "Just track — pick a sport below, then Connect / Simulate."
            : raceMode === "workout" ? "Run a built or imported plan."
            : "Full HYROX race — 8 runs + 8 stations with coaching."}
        </div>
      </div>

      {raceMode === "free" && (
        <div>
          <div className="text-[10px] mono text-[var(--color-ink-faint)] tracking-[0.12em] uppercase mb-2">Classify this session</div>
          <div className="flex flex-wrap gap-2">
            {SINGLE_MODALITIES.map((m) => {
              const active = freeModality === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => onFreeModality(m.id)}
                  className={`px-3 h-9 rounded-lg text-sm border transition-colors ${
                    active
                      ? "bg-[var(--color-volt)] text-black border-transparent font-semibold"
                      : "bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border-[var(--color-line)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  <span className="mr-1">{m.glyph}</span>
                  {m.short}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {raceMode === "workout" && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-[13px] text-[var(--color-ink-dim)]">
            {plan ? (
              <>Plan: <span className="text-[var(--color-ink)] font-semibold">{plan.title}</span> · {plan.intervals.length} intervals</>
            ) : (
              "No plan loaded yet."
            )}
          </div>
          <button onClick={onBuild} className="btn-ghost h-9 px-4 text-[13px]">{plan ? "Edit / swap" : "Build / import workout"}</button>
        </div>
      )}
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
    <footer className="pt-1 pb-3 text-center">
      <p className="text-[10px] text-[var(--color-ink-faint)] max-w-2xl mx-auto">
        DFA-α1 thresholds (0.75 ≈ LT1, 0.50 ≈ LT2) are population defaults — not a medical device.
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
  workout: { adherencePct: number | null; planTitle?: string; segments: SegmentRecord[] },
  modality: Modality
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
    modality,
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
