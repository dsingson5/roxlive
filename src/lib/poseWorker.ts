/**
 * Pose inference Web Worker (Stage 6 — "smooth tracking").
 *
 * Runs MediaPipe PoseLandmarker off the main thread so the UI never blocks on
 * the ~20–40 ms per-frame inference. The main thread grabs each video frame as
 * an ImageBitmap (cheap, transferable) and posts it here; we run detectForVideo
 * and post the 33 landmarks back. The GPU delegate uses an OffscreenCanvas
 * WebGL context created inside MediaPipe — available in workers on Chromium and
 * recent Safari; if it fails we fall back to CPU in-worker, and the main thread
 * falls back to its own synchronous detector if init fails entirely.
 *
 * Protocol:
 *   main → { type:"init", visionEsm, wasmBase, modelUrl }
 *   worker → { type:"ready", delegate } | { type:"error", message }
 *   main → { type:"frame", bitmap, ts }   (bitmap transferred)
 *   worker → { type:"result", ts, landmarks }   (landmarks: array | null)
 */
/// <reference lib="webworker" />

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let landmarker: any = null;
let lastTs = 0;

async function init(msg: any): Promise<void> {
  try {
    const vision: any = await import(/* @vite-ignore */ msg.visionEsm);
    const fileset = await vision.FilesetResolver.forVisionTasks(msg.wasmBase);
    const make = (d: "GPU" | "CPU") =>
      vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelUrl, delegate: d },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let delegate: "GPU" | "CPU" = "GPU";
    try {
      landmarker = await make("GPU");
    } catch {
      delegate = "CPU";
      landmarker = await make("CPU");
    }
    ctx.postMessage({ type: "ready", delegate });
  } catch (e: any) {
    ctx.postMessage({ type: "error", message: String(e?.message || e) });
  }
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "init") {
    await init(msg);
    return;
  }
  if (msg.type === "frame") {
    const bitmap = msg.bitmap as ImageBitmap;
    const ts = msg.ts as number;
    if (!landmarker) {
      try { bitmap.close?.(); } catch { /* ignore */ }
      ctx.postMessage({ type: "result", ts, landmarks: null });
      return;
    }
    // MediaPipe requires strictly-increasing timestamps in VIDEO mode.
    let t = Math.round(ts);
    if (t <= lastTs) t = lastTs + 1;
    lastTs = t;
    let landmarks: any = null;
    try {
      const res = landmarker.detectForVideo(bitmap, t);
      const lms = res?.landmarks?.[0];
      if (lms && lms.length) landmarks = lms.map((p: any) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }));
    } catch {
      landmarks = null; // a single inference failure → no landmarks this frame
    } finally {
      try { bitmap.close?.(); } catch { /* ignore */ }
    }
    ctx.postMessage({ type: "result", ts, landmarks });
  }
};
