import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AthleteProfile,
  HRSample,
  MetricsSnapshot,
  PaceSample,
  VoiceSettings,
  WorkoutPlan,
} from "../types";
import { MetricsEngine } from "../lib/engine";
import { RaceSimulator } from "../lib/simulator";
import { HeartRateBLE, bluetoothSupported } from "../lib/ble";
import { VoiceCoach } from "../lib/voice";
import { computeRunnerView, cumulativeEnds, resolveBand, type RunnerView } from "../lib/workout";
import { zoneBounds } from "../lib/zones";

const now = () => performance.timeOrigin + performance.now();
export const MAX_ATHLETES = 8;
const COLORS = ["#d8ff3a", "#38e1ff", "#ff3d81", "#3dffb5", "#ffb02e", "#b18cff", "#ff6b4d", "#5ad1a0"];

export type SquadSource = "idle" | "sim" | "live";

/** Public per-athlete metadata (the parts React renders / the user edits). */
export interface SquadAthlete {
  id: string;
  name: string;
  color: string;
  profile: AthleteProfile;
  plan: WorkoutPlan | null;
  source: SquadSource;
  deviceName: string | null;
  /** plan start timestamp (ms), null until started */
  anchor: number | null;
}

interface Rec {
  engine: MetricsEngine;
  sim: RaceSimulator | null;
  ble: HeartRateBLE | null;
  // adherence accumulators
  inTarget: number;
  total: number;
}

const emptySnap = (p: AthleteProfile): MetricsSnapshot => ({
  t: now(), elapsedSec: 0, hr: null, hrAvg: null, hrMax: null, zone: null,
  zoneBounds: zoneBounds(p), zoneTimeSec: [0, 0, 0, 0, 0], pctMax: null,
  hrv: { rmssd: null, sdnn: null, beats: 0 }, dfa: { alpha1: null, artifactPct: 0, beats: 0, reliable: false },
  respiration: { brpm: null, confidence: 0 }, decoupling: { pct: null, firstHalf: null, secondHalf: null, ready: false, mode: "speed" },
  speedMps: null, paceSecPerKm: null, distanceM: 0, cadence: null, bodyTempC: null,
  intervalState: "idle", intervalCount: 0, stateElapsedSec: 0, kcal: 0,
});

let seq = 0;
const mkId = () => `ath-${Math.round(performance.now())}-${seq++}`;

export function useSquad(voice: VoiceSettings, baseProfile: AthleteProfile) {
  const [athletes, setAthletes] = useState<SquadAthlete[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, MetricsSnapshot>>({});
  const [views, setViews] = useState<Record<string, RunnerView>>({});
  const [adherence, setAdherence] = useState<Record<string, number | null>>({});
  const [running, setRunning] = useState(false);

  const recs = useRef<Map<string, Rec>>(new Map());
  const athRef = useRef<SquadAthlete[]>([]);
  athRef.current = athletes;
  const coach = useRef<VoiceCoach | null>(null);
  if (coach.current === null) coach.current = new VoiceCoach(voice);
  useEffect(() => coach.current!.setSettings(voice), [voice]);
  const fired = useRef<Set<string>>(new Set());
  const clearFiredFor = (id: string) => {
    // drop this athlete's cue tokens + any shared "all:" tokens (sync changed)
    for (const t of [...fired.current]) {
      if (t.startsWith(`${id}:`) || t.startsWith("all:")) fired.current.delete(t);
    }
  };
  const raf = useRef<number | null>(null);
  const bg = useRef<number | null>(null);
  const lastPub = useRef(0);
  const lastSec = useRef(-1);

  /* ---------------- the shared tick loop ---------------- */
  const tick = useCallback(() => {
    const t = now();
    const list = athRef.current;
    const snaps: Record<string, MetricsSnapshot> = {};
    const vws: Record<string, RunnerView> = {};

    for (const a of list) {
      const rec = recs.current.get(a.id);
      if (!rec) continue;
      const snap = rec.engine.tick(t);
      snaps[a.id] = snap;
      const planElapsed = a.anchor != null ? (t - a.anchor) / 1000 : -1;
      vws[a.id] = computeRunnerView(a.plan, a.profile, voice.leadInSec, planElapsed, snap.hr);
    }

    runVoice(t, list, snaps, vws);
    accrueAdherence(t, list, snaps, vws);

    if (t - lastPub.current >= 100) {
      lastPub.current = t;
      setSnapshots(snaps);
      setViews(vws);
    }
    if (Math.floor(t / 1000) !== lastSec.current) {
      lastSec.current = Math.floor(t / 1000);
      const adh: Record<string, number | null> = {};
      for (const a of list) {
        const r = recs.current.get(a.id);
        adh[a.id] = r && r.total > 1 ? (r.inTarget / r.total) * 100 : null;
      }
      setAdherence(adh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.leadInSec]);

  const loop = useCallback(() => {
    tick();
    raf.current = requestAnimationFrame(loop);
  }, [tick]);

  const ensureLoop = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(loop);
    if (bg.current === null) bg.current = window.setInterval(() => { if (document.hidden) tick(); }, 350);
  }, [loop, tick]);

  // adherence accumulation (writes into recs)
  function accrueAdherence(_t: number, list: SquadAthlete[], snaps: Record<string, MetricsSnapshot>, vws: Record<string, RunnerView>) {
    for (const a of list) {
      const rec = recs.current.get(a.id);
      const v = vws[a.id];
      const snap = snaps[a.id];
      if (!rec || !v || !snap) continue;
      if (v.phase === "running" && v.band && snap.hr != null) {
        const dt = 0.1; // publish cadence ~ approximate; fine for a coarse %
        rec.total += dt;
        if (v.hrStatus === "in") rec.inTarget += dt;
      }
    }
  }

  /* ---------------- squad voice ---------------- */
  function runVoice(_t: number, list: SquadAthlete[], _snaps: Record<string, MetricsSnapshot>, vws: Record<string, RunnerView>) {
    const c = coach.current!;
    const active = list.filter((a) => a.source !== "idle" && a.plan && a.anchor != null);
    const runningOnes = active.filter((a) => {
      const v = vws[a.id];
      return v && (v.phase === "running" || v.phase === "leadin");
    });
    if (runningOnes.length === 0) return;

    // Synced = everyone on the same plan, started together (same anchor).
    const a0 = runningOnes[0];
    const synced =
      runningOnes.length > 1 &&
      runningOnes.every((a) => a.plan?.id === a0.plan?.id && Math.abs((a.anchor ?? 0) - (a0.anchor ?? 0)) < 80);

    const once = (token: string, fn: () => void) => {
      if (fired.current.has(token)) return;
      fired.current.add(token);
      fn();
    };

    if (synced) {
      const v = vws[a0.id];
      const idx = v.currentIndex;
      if (v.phase === "running" && v.interval) {
        once(`all:start:${idx}`, () => c.say(`Everyone. ${v.interval!.name}.`));
        const n = Math.ceil(v.remainingSec);
        if (n >= 1 && n <= 3 && v.remainingSec > 0.05) {
          if (n === 3) once(`all:enter:${idx}`, () => c.say("Everyone."));
          once(`all:cd:${idx}:${n}`, () => { c.say(String(n)); c.beep(n === 1 ? 660 : 760, 90); });
        }
      } else if (v.phase === "done") {
        once("all:done", () => c.say("Everyone done. Great work."));
      }
      return;
    }

    // Independent athletes: announce the name, then count, per athlete.
    for (const a of runningOnes) {
      const v = vws[a.id];
      if (v.phase === "running" && v.interval) {
        once(`${a.id}:start:${v.currentIndex}`, () => c.say(`${a.name}. ${v.interval!.name}.`));
        const n = Math.ceil(v.remainingSec);
        if (n >= 1 && n <= 3 && v.remainingSec > 0.05) {
          if (n === 3) once(`${a.id}:enter:${v.currentIndex}`, () => c.say(`${a.name}.`));
          once(`${a.id}:cd:${v.currentIndex}:${n}`, () => { c.say(String(n)); c.beep(n === 1 ? 660 : 760, 90); });
        }
      } else if (v.phase === "done") {
        once(`${a.id}:done`, () => c.say(`${a.name} done.`));
      }
    }
  }

  /* ---------------- roster management ---------------- */
  const addAthlete = useCallback(() => {
    setAthletes((prev) => {
      if (prev.length >= MAX_ATHLETES) return prev;
      const id = mkId();
      const profile = { ...baseProfile, name: `Athlete ${prev.length + 1}` };
      recs.current.set(id, { engine: new MetricsEngine(profile), sim: null, ble: null, inTarget: 0, total: 0 });
      return [
        ...prev,
        { id, name: profile.name, color: COLORS[prev.length % COLORS.length], profile, plan: null, source: "idle", deviceName: null, anchor: null },
      ];
    });
  }, [baseProfile]);

  const teardown = (id: string) => {
    const rec = recs.current.get(id);
    if (rec) {
      rec.sim?.stop();
      rec.ble?.disconnect();
    }
  };

  const removeAthlete = useCallback((id: string) => {
    teardown(id);
    recs.current.delete(id);
    setAthletes((prev) => prev.filter((a) => a.id !== id));
    setSnapshots((s) => { const n = { ...s }; delete n[id]; return n; });
    setViews((s) => { const n = { ...s }; delete n[id]; return n; });
  }, []);

  const patch = (id: string, fn: (a: SquadAthlete) => SquadAthlete) =>
    setAthletes((prev) => prev.map((a) => (a.id === id ? fn(a) : a)));

  const setName = useCallback((id: string, name: string) => patch(id, (a) => ({ ...a, name, profile: { ...a.profile, name } })), []);
  const setMaxHr = useCallback((id: string, maxHr: number) => {
    patch(id, (a) => {
      const profile = { ...a.profile, maxHr };
      recs.current.get(id)?.engine.setProfile(profile);
      return { ...a, profile };
    });
  }, []);
  const setPlan = useCallback((id: string, plan: WorkoutPlan | null) => patch(id, (a) => ({ ...a, plan })), []);

  /* ---------------- sources + start ---------------- */
  const planTargetFor = (a: SquadAthlete) => {
    if (!a.plan) return undefined;
    const ends = cumulativeEnds(a.plan);
    const lead = voice.leadInSec;
    const KIND: Record<string, number> = { warmup: 0.6, work: 0.85, active: 0.72, rest: 0.6, cooldown: 0.55 };
    const plan = a.plan;
    const profile = a.profile;
    const recId = a.id;
    return (simElapsedSec: number): number | null => {
      // sim elapsed ≈ plan elapsed (source + anchor start together for sims)
      const anchor = athRef.current.find((x) => x.id === recId)?.anchor;
      if (anchor == null) return null;
      const e = simElapsedSec;
      if (e < lead) return null;
      const t = e - lead;
      let idx = ends.findIndex((x) => t < x);
      if (idx < 0) idx = plan.intervals.length - 1;
      const iv = plan.intervals[idx];
      const band = resolveBand(iv.target, profile);
      if (band) return (band.low + band.high) / 2;
      return profile.maxHr * (KIND[iv.kind] ?? 0.7);
    };
  };

  const startSim = useCallback((id: string) => {
    const a = athRef.current.find((x) => x.id === id);
    const rec = recs.current.get(id);
    if (!a || !rec) return;
    rec.sim?.stop();
    rec.ble?.disconnect();
    rec.engine.reset();
    rec.engine.start(now());
    rec.inTarget = 0; rec.total = 0;
    const sim = new RaceSimulator(a.profile, (s: HRSample) => rec.engine.ingestHR(s), (s: PaceSample) => rec.engine.ingestPace(s), {
      targetHrFn: planTargetFor(a),
      onCadence: (t, spm) => rec.engine.ingestCadence(t, spm),
      onTemp: (t, c) => rec.engine.ingestTemp(t, c),
    });
    sim.start();
    rec.sim = sim;
    rec.ble = null;
    patch(id, (x) => ({ ...x, source: "sim", deviceName: "Simulated", anchor: x.plan ? now() : x.anchor }));
    coach.current!.prime();
    clearFiredFor(id); // only this athlete's cues — don't disturb others mid-run
    setRunning(true);
    ensureLoop();
  }, [ensureLoop, voice.leadInSec]);

  const connectSensor = useCallback(async (id: string) => {
    if (!bluetoothSupported()) return;
    const rec = recs.current.get(id);
    if (!rec) return;
    rec.sim?.stop(); rec.sim = null;
    rec.engine.reset();
    const ble = new HeartRateBLE(
      (s) => rec.engine.ingestHR(s),
      (d) => { patch(id, (x) => ({ ...x, deviceName: d.name })); },
      () => {},
      (t, spm) => rec.engine.ingestCadence(t, spm),
      (t, c) => rec.engine.ingestTemp(t, c)
    );
    rec.ble = ble;
    await ble.connect();
    rec.engine.start(now());
    rec.inTarget = 0; rec.total = 0;
    patch(id, (x) => ({ ...x, source: "live" }));
    coach.current!.prime();
    setRunning(true);
    ensureLoop();
  }, [ensureLoop]);

  /** Anchor an athlete's plan now (begins lead-in + coaching). Requires a live source + plan. */
  const startPlan = useCallback((id: string) => {
    coach.current!.prime();
    clearFiredFor(id);
    patch(id, (a) => (a.source !== "idle" && a.plan ? { ...a, anchor: now() } : a));
  }, []);

  const startAll = useCallback(() => {
    coach.current!.prime();
    fired.current = new Set();
    const t = now();
    const list = athRef.current;
    list.forEach((a) => {
      const rec = recs.current.get(a.id);
      if (!rec) return;
      if (a.source === "idle") {
        // auto-start a simulator for anyone without a source
        rec.engine.reset(); rec.engine.start(t); rec.inTarget = 0; rec.total = 0;
        const sim = new RaceSimulator(a.profile, (s) => rec.engine.ingestHR(s), (s) => rec.engine.ingestPace(s), {
          targetHrFn: planTargetFor(a),
          onCadence: (tt, spm) => rec.engine.ingestCadence(tt, spm),
          onTemp: (tt, c) => rec.engine.ingestTemp(tt, c),
        });
        sim.start();
        rec.sim = sim;
      }
    });
    // synchronized anchor for everyone with a plan
    setAthletes((prev) => prev.map((a) => ({
      ...a,
      source: a.source === "idle" ? "sim" : a.source,
      deviceName: a.source === "idle" ? "Simulated" : a.deviceName,
      anchor: a.plan ? t : a.anchor,
    })));
    setRunning(true);
    ensureLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureLoop, voice.leadInSec]);

  const stopAll = useCallback(() => {
    athRef.current.forEach((a) => teardown(a.id));
    if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null; }
    if (bg.current !== null) { clearInterval(bg.current); bg.current = null; }
    coach.current!.cancel();
    fired.current = new Set();
    setAthletes((prev) => prev.map((a) => ({ ...a, source: "idle", anchor: null, deviceName: null })));
    // Clear live state so the cards drop back to their idle controls (the tick
    // loop is stopped, so it won't update these on its own).
    setSnapshots({});
    setViews({});
    setAdherence({});
    setRunning(false);
  }, []);

  useEffect(() => () => {
    athRef.current.forEach((a) => teardown(a.id));
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    if (bg.current !== null) clearInterval(bg.current);
  }, []);

  return {
    athletes, snapshots, views, adherence, running,
    addAthlete, removeAthlete, setName, setMaxHr, setPlan,
    startSim, connectSensor, startPlan, startAll, stopAll,
    supported: bluetoothSupported(),
    emptySnapForProfile: emptySnap,
  };
}
