/**
 * Strength Workout runner — the auto-cycling session player.
 *
 * Form Lab's strength *workout* mode: build (or import) a session, then run it
 * with a SMALL inset camera while a coaching panel drives the set → rest → set
 * cycle. The timing/phase logic is the pure reducer in lib/strengthRunner.ts;
 * this component owns the camera + pose loop, turns the reducer's effects into
 * speech / beeps / camera-gating, logs each finished set to the strength history,
 * and renders the builder + live coaching UI.
 *
 * Self-contained (its own camera) so it can't destabilise the single-set Form
 * Lab path. Stage 3 adds bar calibration + voice commands; Stage 4 adds import.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPoseDetector, type PoseDetector, type PoseQuality } from "../lib/pose";
import { POSE_EDGES, type Landmarks } from "../lib/gait";
import { RepFormAnalyzer, type RepFormSnapshot } from "../lib/repForm";
import { useSpeechCommands, speechCommandsSupported, type VoiceCommand } from "../hooks/useSpeechCommands";
import { EXERCISES, getExercise } from "../lib/exercises";
import { addStrengthSet, fmtLoad, type LoadUnit } from "../lib/strengthHistory";
import {
  newSession, newBlock, newSet, propagateWeight, saveSession, loadSession,
  type StrengthSession, type StrengthBlock,
} from "../lib/strengthSession";
import { fetchStrengthSession, todaysStrengthLetter, type ImportResult, type StrengthLetter } from "../lib/strengthImport";
import {
  initRunner, runnerReducer, runnerView, BRIEF_SEC,
  briefText, restHalfwayText, postSetText, doneText,
  type RunnerState, type RunnerEffect, type RunnerView,
} from "../lib/strengthRunner";

type Status = "setup" | "loading" | "running" | "error";

export function StrengthWorkout({ quality = "full", onRunningChange }: { quality?: PoseQuality; onRunningChange?: (live: boolean) => void }) {
  // ---- session (builder) ----
  const [session, setSession] = useState<StrengthSession>(() => loadSession() ?? seedSession());
  useEffect(() => { saveSession(session); }, [session]);
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // ---- runner ----
  const [runner, setRunner] = useState<RunnerState | null>(null);
  const runnerRef = useRef<RunnerState | null>(null);
  const [status, setStatus] = useState<Status>("setup");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [liveSnap, setLiveSnap] = useState<RepFormSnapshot | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const voiceOnRef = useRef(voiceOn);
  useEffect(() => { voiceOnRef.current = voiceOn; if (!voiceOn) try { window.speechSynthesis.cancel(); } catch { /* */ } }, [voiceOn]);
  // tell the host (Form Lab) when a workout is live/starting, so it can hide the
  // mode tabs — otherwise a stray tab tap would unmount + kill the live workout.
  useEffect(() => { onRunningChange?.(status === "running" || status === "loading"); }, [status, onRunningChange]);
  useEffect(() => () => onRunningChange?.(false), [onRunningChange]); // clear on unmount

  // ---- camera / pose refs ----
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detRef = useRef<PoseDetector | null>(null);
  const repRef = useRef<RepFormAnalyzer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const countingRef = useRef(false);
  const failRef = useRef(0);
  const lastHudRef = useRef(0);
  const lastRepsRef = useRef(0);
  const spokeRef = useRef<{ cue: string; t: number }>({ cue: "", t: 0 });
  const lastSpokeAtRef = useRef(0); // guards a spoken correction from a fast next-rep count
  const lastReportRef = useRef<ReturnType<RepFormAnalyzer["report"]> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  // ---- manual bar calibration (Stage 3) ----
  // The bar is held at the wrists, so once the athlete taps where the bar is we
  // store the offset from the wrist-midpoint and track the bar (+ its path) from
  // the wrist landmarks each frame — robust to plates without object detection.
  const lmRef = useRef<Landmarks | null>(null);
  const barCalRef = useRef<{ dx: number; dy: number } | null>(null);
  const barPosRef = useRef<{ x: number; y: number } | null>(null);
  const barPathRef = useRef<{ x: number; y: number }[]>([]);
  const [calibrating, setCalibrating] = useState(false);
  const calibratingRef = useRef(false);
  useEffect(() => { calibratingRef.current = calibrating; }, [calibrating]);
  const [calibMsg, setCalibMsg] = useState<string | null>(null);
  const [barOn, setBarOn] = useState(false);
  const [voiceCmdOn, setVoiceCmdOn] = useState(false);

  /* ---------------- voice + beep ---------------- */
  const speak = useCallback((text: string, opts?: { interrupt?: boolean }) => {
    if (!voiceOnRef.current || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.volume = 1;
      if (opts?.interrupt) window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* speech unsupported */ }
  }, []);

  const beep = useCallback((freq = 880, durMs = 130, gain = 0.16) => {
    try {
      if (!audioRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioRef.current = new Ctx();
      }
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + durMs / 1000 + 0.02);
    } catch { /* audio unavailable */ }
  }, []);

  /* ---------------- effect processor ---------------- */
  const processEffects = useCallback((effects: RunnerEffect[], state: RunnerState) => {
    for (const e of effects) {
      if (e.kind === "camera") {
        countingRef.current = e.on;
        if (e.on) {
          const exId = runnerView(state, Date.now()).exerciseId;
          repRef.current = new RepFormAnalyzer(getExercise(exId) ?? getExercise("back_squat")!);
          lastRepsRef.current = 0;
          spokeRef.current = { cue: "", t: 0 };
          barPathRef.current = []; // fresh bar-path per set
          setLiveSnap(null);
        } else {
          const rep = repRef.current?.report() ?? null;
          lastReportRef.current = rep;
          const v = runnerView(state, Date.now());
          if (rep && rep.reps > 0 && v.spec) void addStrengthSet(rep, { value: v.spec.weight, unit: v.unit });
          repRef.current = null;
        }
      } else if (e.kind === "beep") {
        beep(e.freq ?? 880);
      } else if (e.kind === "vibrate") {
        try { navigator.vibrate?.(70); } catch { /* */ }
      } else if (e.kind === "cue") {
        const v = runnerView(state, Date.now());
        // brief does NOT interrupt — on a 0s rest it must queue AFTER the post_set
        // summary, not cancel it mid-sentence.
        if (e.name === "brief") speak(briefText(v));
        else if (e.name === "rest_halfway") speak(restHalfwayText(v));
        else if (e.name === "post_set") speak(postSetText(lastReportRef.current, v));
        else if (e.name === "done") speak(doneText(v), { interrupt: true });
        // "go": the 990Hz beep in the same batch is the cue — no speech (don't cut the brief)
      }
    }
  }, [beep, speak]);

  const dispatch = useCallback((action: Parameters<typeof runnerReducer>[1]) => {
    const prev = runnerRef.current;
    if (!prev) return;
    const { state, effects } = runnerReducer(prev, action);
    runnerRef.current = state;
    setRunner(state);
    if (effects.length) processEffects(effects, state);
  }, [processEffects]);

  /* ---------------- camera + pose loop ---------------- */
  const drawSkeleton = useCallback((lm: Landmarks | null) => {
    const cv = canvasRef.current, video = videoRef.current;
    if (!cv || !video) return;
    const cw = (cv.width = video.clientWidth || cv.width);
    const ch = (cv.height = video.clientHeight || cv.height);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!lm) return;
    const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
    const scale = Math.min(cw / vw, ch / vh);
    const dw = vw * scale, dh = vh * scale, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    const X = (n: number) => ox + n * dw, Y = (n: number) => oy + n * dh;
    ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(216,255,58,0.85)";
    for (const [a, b] of POSE_EDGES) {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb || (pa.visibility ?? 1) < 0.3 || (pb.visibility ?? 1) < 0.3) continue;
      ctx.beginPath(); ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y)); ctx.stroke();
    }
    ctx.fillStyle = "rgba(56,225,255,0.95)";
    for (const p of lm) { if (!p || (p.visibility ?? 1) < 0.3) continue; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2.6, 0, Math.PI * 2); ctx.fill(); }

    // calibrated bar: vertical bar-path trail + a horizontal bar marker with plates
    const bp = barPosRef.current;
    if (barCalRef.current && bp) {
      const path = barPathRef.current;
      if (countingRef.current && path.length > 1) { // trail only during the live set
        ctx.strokeStyle = "rgba(255,61,129,0.75)"; ctx.lineWidth = 2;
        ctx.beginPath();
        path.forEach((p, i) => { const x = X(p.x), y = Y(p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
      const bx = X(bp.x), by = Y(bp.y), half = dw * 0.16;
      ctx.strokeStyle = "rgba(56,225,255,0.95)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(bx - half, by); ctx.lineTo(bx + half, by); ctx.stroke();
      ctx.fillStyle = "rgba(56,225,255,0.9)";
      ctx.fillRect(bx - half - 4, by - 9, 5, 18); ctx.fillRect(bx + half - 1, by - 9, 5, 18);
    }
  }, []);

  const loop = useCallback(() => {
    const video = videoRef.current, det = detRef.current;
    if (!runningRef.current || !video || !det) return;
    const ts = performance.now();
    let lm: Landmarks | null = null;
    if (video.readyState >= 2) {
      try { lm = det.detect(video, ts); failRef.current = 0; }
      catch {
        if (++failRef.current >= 30) {
          runningRef.current = false;
          setErrorMsg("Pose engine stopped (graphics context lost). Stop and restart the workout.");
          setStatus("error");
          return;
        }
      }
      if (lm && countingRef.current && repRef.current) repRef.current.push(ts, lm);
    }
    lmRef.current = lm;
    // track the calibrated bar from the wrist-midpoint; record its path during a set
    if (barCalRef.current) {
      const wm = lm ? wristMid(lm) : null;
      if (wm) {
        const pos = { x: wm.x + barCalRef.current.dx, y: wm.y + barCalRef.current.dy };
        barPosRef.current = pos;
        if (countingRef.current) {
          const path = barPathRef.current, last = path[path.length - 1];
          if (!last || Math.hypot(last.x - pos.x, last.y - pos.y) > 0.003) path.push(pos);
          if (path.length > 70) path.shift();
        }
      } else {
        barPosRef.current = null; // wrists not tracked → don't draw a stale marker
      }
    }
    drawSkeleton(lm);

    const now = performance.now();
    if (now - lastHudRef.current > 110) {
      lastHudRef.current = now;
      if (countingRef.current && repRef.current) {
        const snap = repRef.current.snapshot();
        setLiveSnap(snap);
        if (snap.reps !== lastRepsRef.current) {
          lastRepsRef.current = snap.reps;
          // count along + correct. A faulted rep speaks the correction (priority); a
          // clean rep speaks just the number, but NOT within 1.5s of a spoken
          // correction — so a fast next-rep count can't truncate the cue.
          const bad = snap.lastRep?.faults.find((f) => f.severity !== "info");
          if (bad && snap.quality >= 0.4) { speak(`${snap.reps}. ${bad.cue}.`, { interrupt: true }); lastSpokeAtRef.current = now; }
          else if (now - lastSpokeAtRef.current > 1500) { speak(String(snap.reps), { interrupt: true }); lastSpokeAtRef.current = now; }
          dispatch({ type: "REPS", n: snap.reps, now: Date.now() });
        } else {
          // live in-progress correction (throttled)
          const top = snap.liveFaults.find((f) => f.severity !== "info");
          if (top && snap.quality >= 0.4 && top.cue !== spokeRef.current.cue && now - spokeRef.current.t > 2800) {
            spokeRef.current = { cue: top.cue, t: now };
            speak(top.cue);
          }
        }
      } else if (liveSnap) {
        setLiveSnap(null);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [drawSkeleton, dispatch, speak, liveSnap]);

  /* ---------------- start / stop ---------------- */
  const teardown = useCallback(() => {
    // flush an in-progress set so leaving (close / mode-switch / unmount) doesn't
    // silently drop it — mirrors the STOP dispatch's camera-off effect. When stop
    // already flushed (countingRef false / repRef null), this is a no-op (no dup).
    if (countingRef.current && repRef.current) {
      try {
        const rep = repRef.current.report();
        const v = runnerRef.current ? runnerView(runnerRef.current, Date.now()) : null;
        if (rep && rep.reps > 0 && v?.spec) void addStrengthSet(rep, { value: v.spec.weight, unit: v.unit });
      } catch { /* */ }
    }
    runningRef.current = false;
    countingRef.current = false;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    detRef.current?.close(); detRef.current = null;
    repRef.current = null;
    // drop per-run pose/bar state so a previous run's trail/marker can't bleed in
    lmRef.current = null; barPosRef.current = null; barPathRef.current = [];
    try { audioRef.current?.close(); } catch { /* */ } // release the AudioContext (Chrome caps ~6)
    audioRef.current = null;
    try { window.speechSynthesis.cancel(); } catch { /* */ }
  }, []);
  useEffect(() => () => teardown(), [teardown]);

  const startWorkout = useCallback(async () => {
    if (!session.blocks.length) return;
    setErrorMsg(null);
    setStatus("loading");
    // prime audio + speech on the user gesture
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* */ }
    beep(660, 1, 0); // unlock AudioContext
    try {
      if (!detRef.current) detRef.current = await createPoseDetector(quality);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream; video.muted = true; await video.play();
      const st = initRunner(session);
      runnerRef.current = st;
      setRunner(st);
      runningRef.current = true;
      failRef.current = 0; lastHudRef.current = 0;
      setStatus("running");
      rafRef.current = requestAnimationFrame(loop);
      dispatch({ type: "START", now: Date.now() });
    } catch (e) {
      teardown();
      const msg = (e as Error)?.message || String(e);
      setErrorMsg(/permission|denied|notallowed/i.test(msg) ? "Camera permission was denied. Allow access and try again." : `Couldn't start: ${msg}`);
      setStatus("error");
    }
  }, [session, quality, beep, loop, dispatch, teardown]);

  const stopWorkout = useCallback(() => {
    dispatch({ type: "STOP" });
    teardown();
    setRunner(null); runnerRef.current = null;
    setLiveSnap(null);
    setStatus("setup");
  }, [dispatch, teardown]);

  // runner clock — drive briefing/rest countdowns
  useEffect(() => {
    if (status !== "running") return;
    const id = window.setInterval(() => dispatch({ type: "TICK", now: Date.now() }), 200);
    return () => window.clearInterval(id);
  }, [status, dispatch]);

  // tap the camera to mark where the bar is → store the offset from the wrists
  const onCameraClick = useCallback((e: { clientX: number; clientY: number }) => {
    if (!calibratingRef.current) return;
    const lm = lmRef.current, canvas = canvasRef.current, video = videoRef.current;
    const wm = lm ? wristMid(lm) : null;
    if (!canvas || !video) return;
    if (!wm) { setCalibMsg("Stand in frame holding the bar so your wrists show, then tap."); return; } // stay in calibration
    const rect = canvas.getBoundingClientRect();
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
    const scale = Math.min(cw / vw, ch / vh), dw = vw * scale, dh = vh * scale;
    const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    const nx = (e.clientX - rect.left - ox) / dw, ny = (e.clientY - rect.top - oy) / dh;
    barCalRef.current = { dx: nx - wm.x, dy: ny - wm.y };
    barPathRef.current = [];
    setCalibrating(false); setCalibMsg(null);
    setBarOn(true);
  }, []);
  const clearBar = useCallback(() => {
    barCalRef.current = null; barPosRef.current = null; barPathRef.current = [];
    setBarOn(false); setCalibrating(false); setCalibMsg(null);
  }, []);

  // hands-free voice commands (opt-in): "done/rest/next" advances, "stop workout" ends
  const onVoiceCommand = useCallback((c: VoiceCommand) => {
    const st = runnerRef.current;
    if (!st) return;
    if (c === "stop") { stopWorkout(); return; }
    if (st.phase === "set") dispatch({ type: "END_SET", now: Date.now() });
    else if (st.phase === "rest") dispatch({ type: "SKIP_REST", now: Date.now() });
  }, [dispatch, stopWorkout]);
  const { supported: voiceCmdSupported, error: voiceCmdError } = useSpeechCommands(voiceCmdOn && status === "running", onVoiceCommand);

  /* ---------------- builder mutations ---------------- */
  const mutate = useCallback((fn: (s: StrengthSession) => StrengthSession) => setSession((s) => fn(structuredCloneSafe(s))), []);
  const addBlock = (exerciseId: string) => mutate((s) => { s.blocks.push(newBlock(exerciseId, { sets: 3 })); return s; });
  const removeBlock = (bi: number) => mutate((s) => { s.blocks.splice(bi, 1); return s; });
  const setUnit = (bi: number, unit: LoadUnit) => mutate((s) => { s.blocks[bi].unit = unit; return s; });
  const setTempo = (bi: number, idx: number, val: number) => mutate((s) => { const t = (s.blocks[bi].tempo ?? [2, 1, 1]).slice() as [number, number, number]; t[idx] = val; s.blocks[bi].tempo = t; return s; });
  const addSet = (bi: number) => mutate((s) => { const b = s.blocks[bi]; b.sets.push(newSet({ ...b.sets[b.sets.length - 1] })); return s; });
  const removeSet = (bi: number, si: number) => mutate((s) => { if (s.blocks[bi].sets.length > 1) s.blocks[bi].sets.splice(si, 1); return s; });
  // import a hub Strength A/B/C/D session (or today's, via the calendar)
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const applyImport = useCallback((r: ImportResult | null, label: string): void => {
    if (!r) { setImportMsg(`Couldn't load ${label}. Open RoxLive from the Hybrid Crew menu (same site) so it can read your strength pages.`); return; }
    if (!r.session.blocks.length) { setImportMsg(`Loaded ${label}, but found no camera-trackable lifts${r.skipped.length ? ` (${r.skipped.length} accessories skipped)` : ""}.`); return; }
    // don't silently destroy hand-entered work — confirm if the builder has edits
    const cur = sessionRef.current;
    const dirty = cur.blocks.length > 1 || cur.blocks.some((b) => b.sets.some((s) => s.weight != null));
    if (dirty && !window.confirm("Replace your current workout with the imported one? Your typed weights and edits will be lost.")) return;
    setSession(r.session);
    const skip = r.skipped.length ? ` · skipped ${r.skipped.length} accessory (${r.skipped.slice(0, 3).join(", ")}${r.skipped.length > 3 ? "…" : ""}) — no rep counter` : "";
    setImportMsg(`Imported ${label}: ${r.session.blocks.length} lifts${skip}. Add your weights below, then Start.`);
  }, []);
  const importLetter = useCallback(async (l: StrengthLetter) => {
    setImporting(true); setImportMsg(null);
    try { applyImport(await fetchStrengthSession(l), `Strength ${l}`); } finally { setImporting(false); }
  }, [applyImport]);
  const importToday = useCallback(async () => {
    setImporting(true); setImportMsg(null);
    try {
      const l = await todaysStrengthLetter();
      if (!l) { setImportMsg("No strength session is scheduled for today on your calendar — pick A/B/C/D above."); return; }
      applyImport(await fetchStrengthSession(l), `today's Strength ${l}`);
    } finally { setImporting(false); }
  }, [applyImport]);

  const updateSet = (bi: number, si: number, field: keyof StrengthBlock["sets"][number], raw: string) => mutate((s) => {
    const b = s.blocks[bi];
    const num = raw.trim() === "" ? null : Number(raw);
    if (field === "weight") {
      // propagate a weight edit to all later sets in the block (David's ask)
      s.blocks[bi] = propagateWeight(b, si, num != null && num > 0 ? num : null);
    } else {
      const v = num != null && Number.isFinite(num) ? num : (field === "rir" || field === "rpe" ? null : 0);
      (b.sets[si][field] as number | null) = field === "rir" || field === "rpe" ? v : Math.max(0, v ?? 0);
    }
    return s;
  });

  const view = useMemo(() => (runner ? runnerView(runner, Date.now()) : null), [runner]);

  /* ---------------- render ---------------- */
  // The camera <video> must stay mounted even before "running" so startWorkout
  // can attach the stream — so we always render it, hidden until the runner shows.
  const showRunner = status === "running" && !!view;
  return (
    <div className={showRunner ? "grid lg:grid-cols-[1fr_minmax(240px,340px)] gap-4 items-start" : ""}>
      {showRunner ? (
        <RunnerPanel view={view!} liveSnap={liveSnap} voiceOn={voiceOn}
          onToggleVoice={() => setVoiceOn((x) => !x)}
          onEndSet={() => dispatch({ type: "END_SET", now: Date.now() })}
          onSkipRest={() => dispatch({ type: "SKIP_REST", now: Date.now() })}
          onStop={stopWorkout}
        />
      ) : (
        <SessionBuilder
          session={session} onTitle={(t) => mutate((s) => { s.title = t; return s; })}
          onAddBlock={addBlock} onRemoveBlock={removeBlock} onUnit={setUnit} onTempo={setTempo}
          onAddSet={addSet} onRemoveSet={removeSet} onUpdateSet={updateSet}
          onStart={startWorkout} loading={status === "loading"} errorMsg={errorMsg}
          onImportLetter={importLetter} onImportToday={importToday} importMsg={importMsg} importing={importing}
        />
      )}

      {/* SMALL inset camera window — always mounted (hidden until running) */}
      <div className={showRunner ? "lg:sticky lg:top-2" : "hidden"}>
        <div onClick={onCameraClick} className="relative rounded-xl overflow-hidden border border-[var(--color-line2)] bg-black" style={{ aspectRatio: "16 / 9", cursor: calibrating ? "crosshair" : "default" }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted />
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
          {showRunner && view!.phase !== "set" && !calibrating && <div className="absolute inset-0 bg-black/55 grid place-items-center text-[11px] text-[var(--color-ink-faint)] uppercase tracking-wider">{view!.phase === "rest" ? "resting" : view!.phase === "briefing" ? "get ready" : "done"}</div>}
          {calibrating && <div className="absolute inset-0 bg-black/45 grid place-items-center text-center p-3"><div className="text-[12px] text-[var(--color-cyan)] font-semibold">Tap the barbell on screen<div className={`text-[10px] font-normal mt-1 ${calibMsg ? "text-[var(--color-amber)]" : "text-[var(--color-ink-faint)]"}`}>{calibMsg ?? "stand in frame holding the bar, then tap where it sits"}</div></div></div>}
          <div className="absolute bottom-1.5 right-2 text-[9px] mono text-[var(--color-ink-faint)] bg-black/50 px-1.5 py-0.5 rounded">camera</div>
        </div>

        {/* bar calibration + voice commands */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <button
            onClick={() => { if (barOn) { clearBar(); return; } setCalibrating((c) => { if (c) setCalibMsg(null); return !c; }); }}
            className="btn-ghost h-8 px-2.5 text-[12px]"
            style={barOn || calibrating ? { borderColor: "var(--color-cyan)", color: "var(--color-cyan)" } : undefined}
            title="Mark the bar so its path is tracked (uses your wrists, not object detection)"
          >📏 {barOn ? "Clear bar" : calibrating ? "Tap the bar…" : "Mark bar"}</button>
          {voiceCmdSupported && (
            <button
              onClick={() => setVoiceCmdOn((v) => !v)}
              className="btn-ghost h-8 px-2.5 text-[12px] flex items-center gap-1.5"
              style={voiceCmdOn ? { borderColor: "var(--color-volt)", color: "var(--color-volt)" } : undefined}
              title='Say "done" / "next" to advance, "stop workout" to end'
            >🎙 {voiceCmdOn ? <>Listening<span className="live-dot">•</span></> : "Voice cmds"}</button>
          )}
        </div>
        {voiceCmdError && <div className="text-[10px] text-[var(--color-amber)] mt-1">{voiceCmdError}</div>}
        <div className="text-[10px] text-[var(--color-ink-faint)] mt-1.5 leading-relaxed">Coaching aid from a 2D camera — confirm by feel. Keep your whole body in frame, side-on for most lifts. The bar overlay tracks your wrists.</div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Runner panel                                                        */
/* ================================================================== */
function RunnerPanel({ view, liveSnap, voiceOn, onToggleVoice, onEndSet, onSkipRest, onStop }: {
  view: RunnerView; liveSnap: RepFormSnapshot | null; voiceOn: boolean;
  onToggleVoice: () => void; onEndSet: () => void; onSkipRest: () => void; onStop: () => void;
}) {
  const v = view;
  const progress = `Set ${v.globalSetNumber} of ${v.totalGlobalSets}${v.totalBlocks > 1 ? ` · ${v.exerciseName} (lift ${v.blockNumber}/${v.totalBlocks})` : ""}`;
  // tap-to-confirm End so an accidental tap mid-set doesn't end the workout
  const [confirmEnd, setConfirmEnd] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  const handleEnd = () => {
    if (confirmEnd) { if (confirmTimer.current) clearTimeout(confirmTimer.current); onStop(); return; }
    setConfirmEnd(true);
    confirmTimer.current = window.setTimeout(() => setConfirmEnd(false), 2600);
  };
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] tracking-[0.14em] text-[var(--color-ink-faint)] uppercase">{progress}</div>
        <div className="flex items-center gap-1.5">
          <button onClick={onToggleVoice} className="btn-ghost h-8 px-2.5 text-[12px]" style={voiceOn ? { borderColor: "var(--color-volt)", color: "var(--color-volt)" } : undefined} title="Spoken coaching">🔊 {voiceOn ? "on" : "off"}</button>
          <button onClick={handleEnd} className="btn-ghost h-8 px-2.5 text-[12px]" style={{ borderColor: confirmEnd ? "var(--color-red)" : "rgba(255,77,77,0.4)", color: "var(--color-red)", background: confirmEnd ? "rgba(255,77,77,0.12)" : undefined }} title="End the workout">{confirmEnd ? "Tap to confirm" : "■ End"}</button>
        </div>
      </div>

      {v.phase === "briefing" && (
        <div className="card p-5 text-center">
          <div className="card-title mb-1">Get ready — {v.exerciseName}</div>
          <div className="num text-7xl leading-none text-[var(--color-volt)] my-2">{v.briefLeftSec || "·"}</div>
          <div className="text-sm text-[var(--color-ink-dim)]">
            {v.spec?.weight ? <b>{fmtLoad(v.spec.weight, v.unit)} · </b> : null}
            target {v.spec?.targetReps || "AMRAP"} reps
            {v.spec?.rir != null ? ` · ${v.spec.rir} RIR` : ""}{v.spec?.rpe != null ? ` · RPE ${v.spec.rpe}` : ""}
          </div>
          {v.tempo && <div className="text-[12px] text-[var(--color-ink-faint)] mt-1">tempo {v.tempo[0]}-{v.tempo[1]}-{v.tempo[2]} (down-pause-up)</div>}
          {v.standard && <div className="text-[12px] text-[var(--color-ink-dim)] mt-2 leading-relaxed">{v.standard}</div>}
        </div>
      )}

      {v.phase === "set" && (
        <>
          <div className="card p-5">
            <div className="card-title mb-1">{v.exerciseName}{v.spec?.weight ? ` · ${fmtLoad(v.spec.weight, v.unit)}` : ""}</div>
            <div className="flex items-end gap-3">
              <div className="num text-7xl leading-none text-[var(--color-volt)]">{liveSnap?.reps ?? 0}</div>
              <div className="text-lg text-[var(--color-ink-faint)] mb-2">/ {v.spec?.targetReps || "∞"} reps</div>
            </div>
            <div className="text-[12px] text-[var(--color-ink-faint)] mt-1">
              {liveSnap && liveSnap.quality < 0.5 ? "Measuring… keep your whole body in frame" : `${v.spec?.rir != null ? `leave ${v.spec.rir} in reserve · ` : ""}auto-rests at ${v.spec?.targetReps || "—"}`}
            </div>
          </div>
          <div className="card p-4">
            <div className="card-title mb-2">Form — live</div>
            {liveSnap && liveSnap.liveFaults.filter((f) => f.severity !== "info").length === 0 ? (
              <div className="flex items-center gap-2 text-[var(--color-mint)] text-sm"><span>✓</span> Looking clean — keep it up.</div>
            ) : (
              <div className="space-y-1.5">
                {(liveSnap?.liveFaults ?? []).filter((f) => f.severity !== "info").slice(0, 2).map((f) => (
                  <div key={f.code} className="text-[13px]">
                    <span className="font-semibold" style={{ color: f.severity === "fault" ? "var(--color-red)" : "var(--color-amber)" }}>{f.fault}</span>
                    <span className="text-[var(--color-ink-dim)]"> — {f.cue}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={onEndSet} className="btn-volt w-full h-12 text-sm font-semibold">✓ End set{v.spec && v.spec.targetReps > 0 ? " early" : " (AMRAP)"}</button>
        </>
      )}

      {v.phase === "rest" && (
        <>
          <div className="card p-5 text-center">
            <div className="card-title mb-1">Rest</div>
            <div className="num text-7xl leading-none my-2" style={{ color: v.restLeftSec <= 3 ? "var(--color-amber)" : "var(--color-cyan)" }}>{fmtMMSS(v.restLeftSec)}</div>
            <div className="text-sm text-[var(--color-ink-dim)]">
              Next: <b>{v.isLastSetOfBlock && !v.isLastSetOfSession ? "new lift" : v.exerciseName}</b>
              {v.spec ? ` · ${v.spec.targetReps || "AMRAP"} reps` : ""}
            </div>
          </div>
          <button onClick={onSkipRest} className="btn-ghost w-full h-11 text-sm font-semibold">⏭ Skip rest</button>
        </>
      )}

      {v.phase === "done" && (
        <div className="card p-6 text-center">
          <div className="num text-5xl leading-none text-[var(--color-volt)] mb-2">✓</div>
          <div className="text-lg font-semibold mb-1">Workout complete</div>
          <div className="text-sm text-[var(--color-ink-dim)]">{v.completedSets} sets logged to your history.</div>
          <button onClick={onStop} className="btn-volt w-full h-11 text-sm font-semibold mt-4">Back to builder</button>
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Session builder                                                     */
/* ================================================================== */
function SessionBuilder({ session, onTitle, onAddBlock, onRemoveBlock, onUnit, onTempo, onAddSet, onRemoveSet, onUpdateSet, onStart, loading, errorMsg, onImportLetter, onImportToday, importMsg, importing }: {
  session: StrengthSession;
  onTitle: (t: string) => void;
  onAddBlock: (exerciseId: string) => void;
  onRemoveBlock: (bi: number) => void;
  onUnit: (bi: number, u: LoadUnit) => void;
  onTempo: (bi: number, idx: number, v: number) => void;
  onAddSet: (bi: number) => void;
  onRemoveSet: (bi: number, si: number) => void;
  onUpdateSet: (bi: number, si: number, field: keyof StrengthBlock["sets"][number], raw: string) => void;
  onStart: () => void;
  loading: boolean;
  errorMsg: string | null;
  onImportLetter: (l: StrengthLetter) => void;
  onImportToday: () => void;
  importMsg: string | null;
  importing: boolean;
}) {
  const [pick, setPick] = useState(EXERCISES[0].id);
  return (
    <div className="max-w-[760px]">
      {/* import from the hub Strength A/B/C/D pages or today's calendar session */}
      <div className="card p-3 mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="card-title mr-1">Import</span>
          {(["A", "B", "C", "D"] as StrengthLetter[]).map((l) => (
            <button key={l} onClick={() => onImportLetter(l)} disabled={importing} className="btn-ghost h-8 px-3 text-[13px] disabled:opacity-50">Strength {l}</button>
          ))}
          <button onClick={onImportToday} disabled={importing} className="btn-ghost h-8 px-3 text-[13px] disabled:opacity-50" style={{ borderColor: "var(--color-cyan)", color: "var(--color-cyan)" }}>★ Today</button>
          {importing && <span className="text-[12px] text-[var(--color-ink-faint)]">loading…</span>}
        </div>
        {importMsg && <div className="text-[11px] text-[var(--color-ink-dim)] mt-2 leading-relaxed">{importMsg}</div>}
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input value={session.title} onChange={(e) => onTitle(e.target.value)} className="inp h-9 text-sm flex-1" placeholder="Workout name" aria-label="Workout name" />
      </div>

      <div className="space-y-3">
        {session.blocks.map((b, bi) => {
          const ex = getExercise(b.exerciseId);
          return (
            <div key={b.id} className="card p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="font-[var(--font-display)] font-semibold text-sm">{bi + 1}. {ex?.name ?? b.exerciseId}</div>
                <div className="flex items-center gap-1.5">
                  <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-[var(--color-line)]">
                    {(["kg", "lb"] as LoadUnit[]).map((u) => (
                      <button key={u} onClick={() => onUnit(bi, u)} className="px-2 h-6 rounded-md text-[11px]" style={{ background: b.unit === u ? "var(--color-volt)" : "transparent", color: b.unit === u ? "#0b0c06" : "var(--color-ink-dim)" }}>{u}</button>
                    ))}
                  </div>
                  <button onClick={() => onRemoveBlock(bi)} className="btn-ghost h-6 px-2 text-[11px]" title="Remove exercise">✕</button>
                </div>
              </div>

              {/* sets table */}
              <div className="space-y-1.5">
                <div className="grid grid-cols-[1.4rem_1fr_1fr_1fr_1fr_1fr_1.4rem] gap-1.5 text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)] px-0.5">
                  <span>#</span><span>reps</span><span>{b.unit}</span><span>rest s</span><span>RIR</span><span>RPE</span><span></span>
                </div>
                {b.sets.map((s, si) => (
                  <div key={si} className="grid grid-cols-[1.4rem_1fr_1fr_1fr_1fr_1fr_1.4rem] gap-1.5 items-center">
                    <span className="text-[12px] text-[var(--color-ink-faint)] text-center">{si + 1}</span>
                    <input type="number" min={0} value={s.targetReps || ""} onChange={(e) => onUpdateSet(bi, si, "targetReps", e.target.value)} className="inp h-8 text-[12px] px-2" aria-label={`set ${si + 1} reps`} />
                    <input type="number" min={0} step={0.5} value={s.weight ?? ""} onChange={(e) => onUpdateSet(bi, si, "weight", e.target.value)} className="inp h-8 text-[12px] px-2" placeholder="BW" aria-label={`set ${si + 1} weight`} />
                    <input type="number" min={0} step={5} value={s.restSec} onChange={(e) => onUpdateSet(bi, si, "restSec", e.target.value)} className="inp h-8 text-[12px] px-2" aria-label={`set ${si + 1} rest`} />
                    <input type="number" min={0} value={s.rir ?? ""} onChange={(e) => onUpdateSet(bi, si, "rir", e.target.value)} className="inp h-8 text-[12px] px-2" placeholder="—" aria-label={`set ${si + 1} RIR`} />
                    <input type="number" min={0} max={10} value={s.rpe ?? ""} onChange={(e) => onUpdateSet(bi, si, "rpe", e.target.value)} className="inp h-8 text-[12px] px-2" placeholder="—" aria-label={`set ${si + 1} RPE`} />
                    <button onClick={() => onRemoveSet(bi, si)} className="text-[var(--color-ink-faint)] hover:text-[var(--color-red)] text-[12px]" title="Remove set">✕</button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => onAddSet(bi)} className="btn-ghost h-7 px-2.5 text-[12px]">+ set</button>
                <div className="flex items-center gap-1 text-[11px] text-[var(--color-ink-faint)] ml-auto">
                  tempo
                  {[0, 1, 2].map((i) => (
                    <input key={i} type="number" min={0} max={9} value={(b.tempo ?? [2, 1, 1])[i]} onChange={(e) => onTempo(bi, i, Math.max(0, Number(e.target.value) || 0))} className="inp h-7 w-9 text-[11px] px-1.5 text-center" aria-label={`tempo ${["down", "pause", "up"][i]}`} />
                  ))}
                </div>
              </div>
              <div className="text-[10px] text-[var(--color-ink-faint)] mt-1.5">Editing a set's {b.unit} carries to the sets below it.</div>
            </div>
          );
        })}
      </div>

      {/* add exercise */}
      <div className="flex items-center gap-2 mt-3">
        <select value={pick} onChange={(e) => setPick(e.target.value)} className="inp h-9 text-[13px] flex-1">
          {EXERCISES.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button onClick={() => onAddBlock(pick)} className="btn-ghost h-9 px-4 text-sm">+ Add exercise</button>
      </div>

      {errorMsg && <div className="text-[var(--color-amber)] text-sm mt-3">{errorMsg}</div>}
      <button onClick={onStart} disabled={!session.blocks.length || loading} className="btn-volt w-full h-12 text-sm font-semibold mt-4 disabled:opacity-50">
        {loading ? "Starting camera…" : session.blocks.length ? "▶ Start workout" : "Add an exercise to start"}
      </button>
      <div className="text-[11px] text-[var(--color-ink-faint)] mt-2 leading-relaxed">
        The camera counts reps and checks form in a small window; the set auto-ends at your rep target, then rest starts automatically with spoken cues. Importing from Strength A/B/C/D &amp; your calendar is coming next.
      </div>
    </div>
  );
}

/* ---------------- helpers ---------------- */
/** Midpoint of the (visible) wrists — the bar's anchor for calibration. */
function wristMid(lm: Landmarks): { x: number; y: number } | null {
  const L = lm[15], R = lm[16]; // BlazePose: 15 = left wrist, 16 = right wrist
  const lv = !!L && (L.visibility ?? 1) >= 0.3, rv = !!R && (R.visibility ?? 1) >= 0.3;
  if (lv && rv) return { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  if (lv) return { x: L.x, y: L.y };
  if (rv) return { x: R.x, y: R.y };
  return null;
}

function fmtMMSS(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.max(0, sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}`;
}

/** Structured clone that survives older engines (session is plain JSON). */
function structuredCloneSafe<T>(o: T): T {
  try { return structuredClone(o); } catch { return JSON.parse(JSON.stringify(o)); }
}

/** A friendly starter session so the builder isn't empty on first open. */
function seedSession(): StrengthSession {
  const s = newSession("Strength workout");
  s.blocks.push(newBlock("back_squat", { sets: 3, unit: "kg", set: { targetReps: 5, restSec: 150, rir: 2 } }));
  return s;
}
