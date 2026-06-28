import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AthleteProfile,
  DeviceInfo,
  HRSample,
  MetricsSnapshot,
  PaceSample,
  SeriesPoint,
} from "../types";
import { DEFAULT_PROFILE } from "../types";
import { MetricsEngine } from "../lib/engine";
import { RaceSimulator } from "../lib/simulator";
import { HeartRateBLE, bluetoothSupported, bluetoothUnavailableMessage } from "../lib/ble";
import { zoneBounds } from "../lib/zones";

export type SourceMode = "idle" | "demo" | "live";

const now = () => performance.timeOrigin + performance.now();

const emptySnapshot = (profile: AthleteProfile): MetricsSnapshot => ({
  t: now(),
  elapsedSec: 0,
  activeSec: 0,
  recovery: { active: false, secsSince: 0, peakHr: null, hr30: null, hr60: null, hrr30: null, hrr60: null },
  hr: null,
  hrAvg: null,
  hrMax: null,
  zone: null,
  zoneBounds: zoneBounds(profile),
  zoneTimeSec: [0, 0, 0, 0, 0],
  pctMax: null,
  hrv: { rmssd: null, sdnn: null, beats: 0 },
  dfa: { alpha1: null, artifactPct: 0, beats: 0, reliable: false },
  respiration: { brpm: null, confidence: 0 },
  decoupling: { pct: null, firstHalf: null, secondHalf: null, ready: false, mode: "speed" },
  speedMps: null,
  paceSecPerKm: null,
  distanceM: 0,
  cadence: null,
  bodyTempC: null,
  intervalState: "idle",
  intervalCount: 0,
  stateElapsedSec: 0,
  kcal: 0,
});

const PROFILE_KEY = "roxlive.profile.v1";

function loadProfile(): AthleteProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_PROFILE;
}

export function useEngine() {
  const [profile, setProfileState] = useState<AthleteProfile>(loadProfile);
  const engineRef = useRef<MetricsEngine>(new MetricsEngine(profile));
  const simRef = useRef<RaceSimulator | null>(null);
  const bleRef = useRef<HeartRateBLE | null>(null);

  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(() => emptySnapshot(profile));
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [mode, setMode] = useState<SourceMode>("idle");
  const [error, setError] = useState<string | null>(null);

  const rafRef = useRef<number | null>(null);
  const gpsWatchId = useRef<number | null>(null);
  const bgTimer = useRef<number | null>(null);
  const lastSnap = useRef(0);
  const lastSeries = useRef(0);

  const clearGps = useCallback(() => {
    if (gpsWatchId.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(gpsWatchId.current);
      gpsWatchId.current = null;
    }
  }, []);

  // One tick of work: advance the engine and publish snapshot/series.
  const runTick = useCallback(() => {
    const t = now();
    const snap = engineRef.current.tick(t);
    if (t - lastSnap.current >= 90) {
      lastSnap.current = t;
      setSnapshot(snap);
    }
    if (t - lastSeries.current >= 1000) {
      lastSeries.current = t;
      setSeries([...engineRef.current.getSeries()]);
    }
  }, []);

  // rAF drives smooth updates while visible; a setInterval keep-alive takes
  // over when the tab is backgrounded (rAF is paused while hidden) so the
  // workout timer, voice cues and metrics keep running in the background.
  const loop = useCallback(() => {
    runTick();
    rafRef.current = requestAnimationFrame(loop);
  }, [runTick]);

  const startLoop = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
    if (bgTimer.current === null) {
      bgTimer.current = window.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) runTick();
      }, 350);
    }
  }, [loop, runTick]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (bgTimer.current !== null) {
      clearInterval(bgTimer.current);
      bgTimer.current = null;
    }
  }, []);

  // App-level pause/resume — freezes active time + the recorded trace while the
  // sensor keeps streaming HR for the live display.
  const pause = useCallback(() => engineRef.current.pause(), []);
  const resume = useCallback(() => engineRef.current.resume(), []);

  // Heart-rate recovery capture (HRR30/HRR60) — anchor effort-end, read the result.
  const startRecovery = useCallback(() => engineRef.current.startRecovery(now()), []);
  const clearRecovery = useCallback(() => engineRef.current.clearRecovery(), []);
  const getRecovery = useCallback(() => engineRef.current.getRecovery(), []);

  const onHR = useCallback((s: HRSample) => engineRef.current.ingestHR(s), []);
  const onPace = useCallback((s: PaceSample) => engineRef.current.ingestPace(s), []);
  const onCadence = useCallback((t: number, spm: number) => engineRef.current.ingestCadence(t, spm), []);
  const onTemp = useCallback((t: number, c: number) => engineRef.current.ingestTemp(t, c), []);

  // (Re-)arm the GPS pace watch (drives speed/distance/Pa:HR decoupling). Called
  // on every connect — including the keep-connected REUSE path, which would
  // otherwise never re-watch after a prior stop()/reset() tore the watch down.
  const armGps = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    clearGps();
    gpsWatchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const sp = pos.coords.speed;
        if (sp !== null && Number.isFinite(sp)) onPace({ t: now(), speedMps: sp, source: "gps" });
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
  }, [onPace, clearGps]);

  const startDemo = useCallback(
    (opts?: { targetHrFn?: (elapsedSec: number) => number | null }) => {
      setError(null);
      engineRef.current.reset();
      engineRef.current.start(now());
      const sim = new RaceSimulator(profile, onHR, onPace, {
        targetHrFn: opts?.targetHrFn,
        onCadence,
        onTemp,
      });
      sim.start();
      simRef.current = sim;
      setMode("demo");
      setDevice({
        id: "sim",
        name: "Simulated Sensor",
        status: "connected",
        battery: 88,
        primary: true,
        lastHr: null,
        hasRR: true,
        simulated: true,
      });
      startLoop();
    },
    [profile, onHR, onPace, onCadence, onTemp, startLoop]
  );

  const connect = useCallback(async () => {
    setError(null);
    // Reuse an already-connected sensor (we keep it connected across sessions) so
    // the next workout starts instantly without re-opening the OS pairing chooser.
    if (bleRef.current?.isConnected()) {
      engineRef.current.reset();
      engineRef.current.start(now());
      setMode("live");
      startLoop();
      armGps(); // re-arm GPS — the prior stop()/reset() cleared the watch
      return;
    }
    if (!bluetoothSupported()) {
      setError(bluetoothUnavailableMessage());
      return;
    }
    engineRef.current.reset();
    const ble = new HeartRateBLE(
      (s) => onHR(s),
      (d) => setDevice(d),
      (msg) => setError(msg),
      (t, spm) => onCadence(t, spm),
      (t, c) => onTemp(t, c)
    );
    bleRef.current = ble;
    await ble.connect();
    engineRef.current.start(now());
    setMode("live");
    startLoop();
    armGps(); // optional GPS pace for Pa:HR / decoupling
  }, [onHR, onCadence, onTemp, startLoop, armGps]);

  const stop = useCallback((opts?: { keepSensor?: boolean }) => {
    simRef.current?.stop();
    simRef.current = null;
    // Keep the BLE sensor connected across sessions by default — only a manual
    // disconnect (or reset) drops it. (The simulator is always torn down.)
    if (!opts?.keepSensor) {
      bleRef.current?.disconnect();
      bleRef.current = null;
    }
    clearGps();
    engineRef.current.stop();
    stopLoop();
    // final snapshot
    setSnapshot(engineRef.current.tick(now()));
    setSeries([...engineRef.current.getSeries()]);
    setMode("idle");
  }, [stopLoop, clearGps]);

  /** Manual sensor disconnect — the only path that drops a real BLE device. */
  const disconnect = useCallback(() => {
    bleRef.current?.disconnect();
    bleRef.current = null;
    setDevice(null);
  }, []);

  // Re-anchor the session clock + metrics to "now" WITHOUT dropping the live
  // source (used by the Free START gate so recording begins at the countdown,
  // not when the sensor first connected). The BLE/sim keep feeding the same
  // engine; only the accumulators + start time reset.
  const restartSession = useCallback(() => {
    engineRef.current.reset();
    engineRef.current.start(now());
    lastSeries.current = 0;
    lastSnap.current = 0;
    setSeries([]);
    setSnapshot(engineRef.current.tick(now()));
  }, []);

  const reset = useCallback((opts?: { keepSensor?: boolean }) => {
    simRef.current?.stop();
    simRef.current = null;
    // Keep a real BLE sensor connected unless this is a full teardown; the
    // simulator is always cleared.
    const keep = opts?.keepSensor && bleRef.current?.isConnected();
    if (!keep) {
      bleRef.current?.disconnect();
      bleRef.current = null;
    }
    clearGps();
    engineRef.current.reset();
    stopLoop();
    setSnapshot(emptySnapshot(profile));
    setSeries([]);
    if (!keep) setDevice(null);
    setMode("idle");
    setError(null);
  }, [profile, stopLoop, clearGps]);

  const setProfile = useCallback((p: AthleteProfile) => {
    setProfileState(p);
    engineRef.current.setProfile(p);
    simRef.current?.setProfile(p);
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(
    () => () => {
      stopLoop();
      clearGps();
    },
    [stopLoop, clearGps]
  );

  const supported = useMemo(() => bluetoothSupported(), []);

  return {
    profile,
    setProfile,
    snapshot,
    series,
    device,
    mode,
    error,
    supported,
    startDemo,
    connect,
    stop,
    disconnect,
    pause,
    resume,
    startRecovery,
    clearRecovery,
    getRecovery,
    reset,
    restartSession,
    simRef,
  };
}
