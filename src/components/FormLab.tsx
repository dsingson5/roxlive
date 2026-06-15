/**
 * Form Lab — camera-based running cadence & form analysis.
 *
 * Implements the browser-live build the spec ranks as the RoxLive-appropriate
 * target: MediaPipe BlazePose on a side-view video → live cadence (the
 * validated trust anchor) + overstride + vertical oscillation + trunk lean +
 * knee drive + L/R balance, with a cadence-retraining metronome. Works on a
 * live camera or an uploaded clip (post-hoc, which the spec notes is the most
 * reliable path). Ground-contact-time and foot-strike are intentionally omitted
 * — they need 120–240 fps that phones don't deliver — and called out as such.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GaitAnalyzer, POSE_EDGES, type GaitSnapshot, type Landmarks } from "../lib/gait";
import { createPoseDetector, type PoseDetector, type PoseQuality } from "../lib/pose";
import { Metronome } from "../lib/metronome";

type Source = "camera" | "upload";
type Status = "idle" | "loading" | "ready" | "running" | "summary" | "error";

const TARGET_MIN = 170; // evidence-based "good" cadence band (for coloring)
const TARGET_MAX = 185;
const SLIDER_MIN = 160; // metronome target is adjustable wider than the band…
const SLIDER_MAX = 200; // …so an already-fast runner can still cue "a touch higher"

export function FormLab({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detRef = useRef<PoseDetector | null>(null);
  const gaitRef = useRef<GaitAnalyzer>(new GaitAnalyzer());
  const metroRef = useRef<Metronome | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const objUrlRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const startingRef = useRef(false); // re-entrancy guard across the async model load
  const failRef = useRef(0); // consecutive inference failures (engine/WebGL loss)
  const rafRef = useRef<number | null>(null);
  const lastHudRef = useRef(0);
  const fpsRef = useRef({ n: 0, t0: 0, fps: 0 });

  const [source, setSource] = useState<Source>("camera");
  const [quality, setQuality] = useState<PoseQuality>("full");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GaitSnapshot | null>(null);
  const [summary, setSummary] = useState<GaitSnapshot | null>(null);
  const [targetSpm, setTargetSpm] = useState(180);
  const [metroOn, setMetroOn] = useState(false);
  const [fps, setFps] = useState(0);
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | "">("");
  const [loadingMsg, setLoadingMsg] = useState("");

  // keep target spm live for the metronome
  useEffect(() => {
    metroRef.current?.setSpm(targetSpm);
  }, [targetSpm]);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    stopLoop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    metroRef.current?.dispose();
    metroRef.current = null;
    detRef.current?.close();
    detRef.current = null;
  }, [stopLoop]);

  // teardown on unmount
  useEffect(() => () => teardown(), [teardown]);

  // modal scaffolding: Escape closes (stopping the camera via unmount→teardown),
  // and lock background scroll while the full-screen overlay is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  /** Ensure the pose model is loaded (CDN). */
  const ensureDetector = useCallback(async () => {
    if (detRef.current) return detRef.current;
    setStatus("loading");
    setLoadingMsg("Loading the pose model (first time ~3–6s)…");
    const d = await createPoseDetector(quality);
    detRef.current = d;
    setDelegate(d.delegate);
    return d;
  }, [quality]);

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
    const dw = vw * scale, dh = vh * scale;
    const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    const X = (n: number) => ox + n * dw;
    const Y = (n: number) => oy + n * dh;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(216,255,58,0.85)"; // volt
    for (const [a, b] of POSE_EDGES) {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb || (pa.visibility ?? 1) < 0.3 || (pb.visibility ?? 1) < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(X(pa.x), Y(pa.y));
      ctx.lineTo(X(pb.x), Y(pb.y));
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(56,225,255,0.95)"; // cyan joints
    for (const p of lm) {
      if (!p || (p.visibility ?? 1) < 0.3) continue;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const loop = useCallback(() => {
    const video = videoRef.current, det = detRef.current;
    if (!runningRef.current || !video || !det) return;
    const ts = source === "camera" ? performance.now() : video.currentTime * 1000;
    let lm: Landmarks | null = null;
    if (video.readyState >= 2) {
      try {
        lm = det.detect(video, ts);
        failRef.current = 0;
      } catch {
        // persistent throws (e.g. lost WebGL context) → surface & stop, don't
        // sit on a frozen skeleton with a ticking fps counter.
        if (++failRef.current >= 30) {
          stopLoop();
          detRef.current?.close();
          detRef.current = null;
          setErrorMsg("Pose engine stopped (graphics context may have been lost). Press Start to retry.");
          setStatus("error");
          return;
        }
      }
      if (lm) gaitRef.current.push(ts, lm);
    }
    drawSkeleton(lm);

    // fps
    const f = fpsRef.current;
    f.n++;
    const now = performance.now();
    if (!f.t0) f.t0 = now;
    if (now - f.t0 >= 1000) {
      f.fps = (f.n * 1000) / (now - f.t0);
      f.n = 0;
      f.t0 = now;
    }

    // throttle HUD updates (~5 Hz)
    if (now - lastHudRef.current > 200) {
      lastHudRef.current = now;
      setMetrics(gaitRef.current.snapshot());
      setFps(Math.round(f.fps));
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [drawSkeleton, source, stopLoop]);

  const start = useCallback(async () => {
    // Re-entrancy guard: the model load is async (~seconds), during which the
    // Start button is still visible — a second click must be a no-op, or we'd
    // leak a second detector + camera stream and a duplicate rAF loop.
    if (startingRef.current || runningRef.current) return;
    startingRef.current = true;
    setErrorMsg(null);
    setSummary(null);
    // clear any orphaned stream / loop defensively before acquiring new ones
    stopLoop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    failRef.current = 0;
    try {
      await ensureDetector();
      const video = videoRef.current!;
      if (source === "camera") {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
          audio: false,
        });
        streamRef.current = stream;
        video.srcObject = stream;
        video.muted = true;
        await video.play();
      } else {
        if (!video.src) {
          setStatus("ready");
          setErrorMsg("Choose a side-view clip to analyze.");
          return;
        }
        video.currentTime = 0;
        await video.play();
      }
      gaitRef.current.reset();
      setMetrics(null);
      fpsRef.current = { n: 0, t0: 0, fps: 0 };
      runningRef.current = true;
      setStatus("running");
      if (metroOn) {
        metroRef.current = metroRef.current || new Metronome(targetSpm);
        metroRef.current.setSpm(targetSpm);
        metroRef.current.start();
      }
      // for uploaded clips, stop automatically at the end
      video.onended = () => stop();
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      // release the camera on the error path so the LED turns off
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const v = videoRef.current;
      if (v) v.srcObject = null;
      const msg = (e as Error)?.message || String(e);
      setErrorMsg(/permission|denied|notallowed/i.test(msg) ? "Camera permission was denied. Allow camera access and try again." : `Couldn't start: ${msg}`);
      setStatus("error");
    } finally {
      startingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureDetector, source, metroOn, targetSpm, loop, stopLoop]);

  const stop = useCallback(() => {
    stopLoop();
    const snap = gaitRef.current.snapshot();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
    }
    metroRef.current?.stop();
    setMetroOn(false); // keep the toggle in sync with the now-silent metronome
    setSummary(snap.steps > 0 ? snap : null);
    setStatus("summary");
  }, [stopLoop]);

  const toggleMetro = useCallback(() => {
    setMetroOn((on) => {
      const next = !on;
      if (!metroRef.current) metroRef.current = new Metronome(targetSpm);
      if (next) {
        metroRef.current.setSpm(targetSpm);
        metroRef.current.start();
      } else {
        metroRef.current.stop();
      }
      return next;
    });
  }, [targetSpm]);

  const onFile = useCallback((file: File) => {
    const video = videoRef.current!;
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    const url = URL.createObjectURL(file);
    objUrlRef.current = url;
    video.srcObject = null;
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.load();
    setStatus("ready");
    setErrorMsg(null);
  }, []);

  const running = status === "running";

  return (
    <div className="fixed inset-0 z-[60] bg-[var(--color-bg)] overflow-y-auto" role="dialog" aria-modal="true" aria-label="Form Lab">
      <div className="max-w-[1480px] mx-auto px-4 sm:px-6 py-4">
        {/* header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <CamIcon />
            <h2 className="font-[var(--font-display)] text-xl font-bold">Form Lab</h2>
            <span className="text-[10px] tracking-[0.16em] text-[var(--color-ink-faint)] uppercase hidden sm:inline">Cadence &amp; running form</span>
          </div>
          <button onClick={onClose} className="btn-ghost h-9 px-3 text-sm flex items-center gap-1.5">✕ Close</button>
        </div>

        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-4">
          {/* video + overlay */}
          <div>
            <div className="relative rounded-2xl overflow-hidden border border-[var(--color-line2)] bg-black" style={{ aspectRatio: "16 / 9" }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted />
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

              {/* big cadence readout */}
              {running && metrics && (
                <div className="absolute top-3 left-3 rounded-xl bg-black/55 backdrop-blur px-3 py-2">
                  <div className="text-[9px] tracking-[0.18em] text-[var(--color-ink-faint)] uppercase">Cadence</div>
                  <div className="num text-4xl leading-none" style={{ color: cadenceColor(metrics.cadenceSpm) }}>
                    {metrics.cadenceSpm ?? "—"}<span className="text-sm text-[var(--color-ink-faint)] ml-1">spm</span>
                  </div>
                  <div className="text-[10px] text-[var(--color-ink-faint)] mt-0.5">target {TARGET_MIN}–{TARGET_MAX}</div>
                </div>
              )}
              {running && (
                <div className="absolute bottom-3 right-3 text-[10px] mono px-2 py-1 rounded-lg bg-black/55 text-[var(--color-ink-faint)]">
                  {fps} fps{delegate ? ` · ${delegate}` : ""} {fps < 25 && <span className="text-[var(--color-amber)]">· low — cadence still ok</span>}
                </div>
              )}

              {/* idle / loading overlay */}
              {(status === "idle" || status === "ready" || status === "loading" || status === "error") && (
                <div className="absolute inset-0 grid place-items-center p-6 text-center">
                  <div>
                    {status === "loading" ? (
                      <>
                        <div className="animate-spin w-8 h-8 border-2 border-[var(--color-volt)] border-t-transparent rounded-full mx-auto mb-3" />
                        <div className="text-sm text-[var(--color-ink-dim)]">{loadingMsg}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-[var(--color-ink-faint)] text-sm max-w-sm">
                          {source === "camera"
                            ? "Place the phone on a tripod, perpendicular to the runner, at hip height — runner centered, full body in frame."
                            : "Upload a side-view clip (perpendicular, hip height). Post-hoc analysis reads every frame, so it's the most accurate."}
                        </div>
                        {errorMsg && <div className="text-[var(--color-amber)] text-sm mt-3">{errorMsg}</div>}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* controls */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {!running ? (
                <>
                  <div className="flex bg-white/[0.04] rounded-xl p-0.5 border border-[var(--color-line)]">
                    <Seg active={source === "camera"} onClick={() => setSource("camera")}>Live camera</Seg>
                    <Seg active={source === "upload"} onClick={() => setSource("upload")}>Upload clip</Seg>
                  </div>
                  {source === "upload" && (
                    <label className="btn-ghost h-9 px-3 text-[13px] cursor-pointer">
                      Choose clip…
                      <input type="file" accept="video/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
                    </label>
                  )}
                  <button onClick={start} disabled={status === "loading"} className="btn-volt h-9 px-5 text-sm font-semibold disabled:opacity-50">{status === "loading" ? "Loading…" : "▶ Start"}</button>
                </>
              ) : (
                <button onClick={stop} className="btn-ghost h-9 px-5 text-sm" style={{ borderColor: "rgba(255,77,77,0.4)", color: "var(--color-red)" }}>■ Stop &amp; review</button>
              )}

              {/* metronome */}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={toggleMetro}
                  className="btn-ghost h-9 px-3 text-[13px] flex items-center gap-1.5"
                  style={metroOn ? { borderColor: "var(--color-volt)", color: "var(--color-volt)" } : undefined}
                  title="Audible step cue for cadence retraining"
                >
                  ♩ Metronome {metroOn ? "on" : "off"}
                </button>
                <div className="flex items-center gap-2">
                  <input type="range" min={SLIDER_MIN} max={SLIDER_MAX} step={1} value={targetSpm} onChange={(e) => setTargetSpm(+e.target.value)} className="w-28 accent-[var(--color-volt)]" />
                  <span className="num text-sm w-16">{targetSpm}<span className="text-[10px] text-[var(--color-ink-faint)] ml-1">spm</span></span>
                </div>
              </div>
            </div>

            {/* model quality (idle only) */}
            {!running && status !== "summary" && (
              <div className="flex items-center gap-2 mt-2 text-[11px] text-[var(--color-ink-faint)]">
                <span>Model:</span>
                <div className="flex bg-white/[0.04] rounded-lg p-0.5 border border-[var(--color-line)]">
                  {(["lite", "full", "heavy"] as PoseQuality[]).map((q) => (
                    <button key={q} onClick={() => { setQuality(q); detRef.current?.close(); detRef.current = null; }}
                      className="px-2.5 h-6 rounded-md text-[11px] capitalize"
                      style={{ background: quality === q ? "var(--color-volt)" : "transparent", color: quality === q ? "#0b0c06" : "var(--color-ink-dim)" }}>
                      {q === "lite" ? "Fast" : q === "full" ? "Balanced" : "Accurate"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* metrics panel */}
          <div className="space-y-3">
            {status === "summary" && summary ? (
              <SummaryPanel s={summary} onAgain={() => setStatus("idle")} />
            ) : (
              <LivePanel m={metrics} running={running} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function cadenceColor(spm: number | null): string {
  if (spm == null) return "var(--color-ink-faint)";
  if (spm >= TARGET_MIN && spm <= TARGET_MAX) return "var(--color-mint)";
  if (spm >= TARGET_MIN - 8 && spm < TARGET_MIN) return "var(--color-amber)";
  return "var(--color-cyan)";
}
function overstrideColor(deg: number | null): string {
  if (deg == null) return "var(--color-ink-faint)";
  if (deg <= 5) return "var(--color-mint)";
  if (deg <= 10) return "var(--color-amber)";
  return "var(--color-red)";
}

function LivePanel({ m, running }: { m: GaitSnapshot | null; running: boolean }) {
  return (
    <>
      <div className="card p-4">
        <div className="card-title mb-1">Cadence</div>
        <div className="flex items-end gap-2">
          <div className="num text-5xl leading-none" style={{ color: cadenceColor(m?.cadenceSpm ?? null) }}>{m?.cadenceSpm ?? "—"}</div>
          <div className="text-sm text-[var(--color-ink-faint)] mb-1">spm · target {TARGET_MIN}–{TARGET_MAX}</div>
        </div>
        <div className="text-[11px] text-[var(--color-ink-faint)] mt-1">
          {running ? (m && m.cadenceConfidence < 0.5 ? "Measuring… keep the full body in side view" : "The most reliable metric (lab-validated).") : "Press Start to measure."}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Overstride" value={m?.overstrideShankDeg != null ? `${m.overstrideShankDeg > 0 ? "+" : ""}${m.overstrideShankDeg}°` : "—"}
          sub={m?.overstriding ? "foot ahead — shorten stride" : "shank near vertical ✓"} color={overstrideColor(m?.overstrideShankDeg ?? null)} />
        <Metric label="Foot ahead" value={m?.footAheadPct != null ? `${m.footAheadPct}%` : "—"} sub="of leg, at contact" />
        <Metric label="Vert. oscillation" value={m?.verticalOscCm != null ? `${m.verticalOscCm} cm` : "—"} sub="pelvis bounce (est)" />
        <Metric label="Trunk lean" value={m?.trunkLeanDeg != null ? `${m.trunkLeanDeg}°` : "—"} sub="from vertical" />
        <Metric label="Knee drive" value={m?.kneeDrivePct != null ? `${m.kneeDrivePct}%` : "—"} sub="peak knee lift" />
        <Metric label="L/R balance" value={m?.balancePct != null ? `${Math.round(m.balancePct)}%` : "—"} sub="50% = even" />
      </div>

      <div className="card p-3 text-[11px] text-[var(--color-ink-faint)] leading-relaxed">
        <span className="text-[var(--color-ink-dim)] font-semibold">Not measured:</span> ground-contact time &amp; foot-strike pattern need 120–240 fps — phone cameras can't capture them reliably, so RoxLive doesn't guess. Cadence &amp; overstride are the trustworthy targets.
      </div>
    </>
  );
}

function SummaryPanel({ s, onAgain }: { s: GaitSnapshot; onAgain: () => void }) {
  return (
    <>
      <div className="card p-4">
        <div className="card-title mb-2">Session summary</div>
        <div className="flex items-end gap-2 mb-1">
          <div className="num text-5xl leading-none" style={{ color: cadenceColor(s.cadenceSpm) }}>{s.cadenceSpm ?? "—"}</div>
          <div className="text-sm text-[var(--color-ink-faint)] mb-1">spm avg cadence</div>
        </div>
        <div className="text-[11px] text-[var(--color-ink-faint)]">{s.steps} steps · tracking quality {Math.round(s.quality * 100)}%</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Overstride" value={s.overstrideShankDeg != null ? `${s.overstrideShankDeg > 0 ? "+" : ""}${s.overstrideShankDeg}°` : "—"}
          sub={s.overstriding ? "overstriding" : "good"} color={overstrideColor(s.overstrideShankDeg)} />
        <Metric label="Foot ahead" value={s.footAheadPct != null ? `${s.footAheadPct}%` : "—"} sub="at contact" />
        <Metric label="Vert. oscillation" value={s.verticalOscCm != null ? `${s.verticalOscCm} cm` : "—"} sub="est" />
        <Metric label="Trunk lean" value={s.trunkLeanDeg != null ? `${s.trunkLeanDeg}°` : "—"} sub="from vertical" />
        <Metric label="Knee drive" value={s.kneeDrivePct != null ? `${s.kneeDrivePct}%` : "—"} sub="peak lift" />
        <Metric label="L/R balance" value={s.balancePct != null ? `${Math.round(s.balancePct)}%` : "—"} sub="50% = even" />
      </div>
      <button onClick={onAgain} className="btn-volt w-full h-11 text-sm font-semibold">Run another</button>
      {s.overstriding && (
        <div className="card p-3 text-[11px] text-[var(--color-ink-dim)] leading-relaxed" style={{ borderColor: "rgba(255,176,46,0.35)" }}>
          You're landing with the foot ahead of the knee. {s.cadenceSpm != null && s.cadenceSpm < TARGET_MAX
            ? "A 5–10% cadence increase (nudge the metronome up) shortens stride and cuts loading — the best-evidenced way to reduce tibial stress."
            : "Your cadence is already high, so focus on landing with the foot closer under your hips rather than reaching out — that shortens stride and cuts loading."}
        </div>
      )}
    </>
  );
}

function Metric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-[var(--color-line)] p-3">
      <div className="num text-2xl" style={{ color: color ?? "var(--color-ink)" }}>{value}</div>
      <div className="text-[10px] tracking-[0.1em] text-[var(--color-ink-faint)] mt-1 uppercase">{label}</div>
      {sub && <div className="text-[10px] text-[var(--color-ink-faint)] mt-0.5">{sub}</div>}
    </div>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="px-3 h-8 rounded-lg text-[13px] font-semibold transition-colors"
      style={{ background: active ? "var(--color-volt)" : "transparent", color: active ? "#0b0c06" : "var(--color-ink-dim)" }}>
      {children}
    </button>
  );
}

const CamIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-volt)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" />
  </svg>
);
