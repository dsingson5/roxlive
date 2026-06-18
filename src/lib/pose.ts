/**
 * MediaPipe Pose Landmarker wrapper for RoxLive's Form Lab.
 *
 * The spec recommends MediaPipe BlazePose ("the only engine with published
 * running-gait timing validation") and loading it from a CDN so a static PWA
 * needs no server and no heavy bundle. We dynamic-import the tasks-vision ESM
 * at runtime and pull the model + wasm from jsDelivr / Google's model store, so
 * none of this is in the main app chunk — it loads only when Form Lab opens.
 */

import type { Landmarks } from "./gait";

const VERSION = "0.10.21";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const VISION_ESM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const MODELS: Record<string, string> = {
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
};

export type PoseQuality = "lite" | "full" | "heavy";

export interface PoseDetector {
  /** Detect on a video frame; returns 33 landmarks or null if no person found.
   *  Throws if the inference engine fails (e.g. WebGL context lost) — callers
   *  should count consecutive throws and surface a recoverable error. */
  detect(video: HTMLVideoElement, tMs: number): Landmarks | null;
  /** which delegate actually won (GPU unless it failed to init) */
  readonly delegate: "GPU" | "CPU";
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let visionMod: any = null;

/** Load tasks-vision once (cached). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadVision(): Promise<any> {
  if (visionMod) return visionMod;
  visionMod = await import(/* @vite-ignore */ VISION_ESM);
  return visionMod;
}

/** Is the worker-backed detector usable in this browser? */
export function canUseWorkerPose(): boolean {
  return typeof Worker !== "undefined" && typeof createImageBitmap === "function";
}

/**
 * Worker-backed detector (Stage 6 "smooth tracking"). Implements the SAME
 * synchronous PoseDetector.detect() contract — but instead of blocking on
 * inference it dispatches the current frame to a Web Worker and returns the most
 * recently completed landmarks (typically 1 frame stale). This keeps the
 * existing render/analyze loop completely unchanged while moving the heavy
 * MediaPipe work off the main thread. Throws if the worker can't initialize, so
 * callers can fall back to createPoseDetector().
 */
export async function createWorkerPoseDetector(quality: PoseQuality = "full"): Promise<PoseDetector> {
  // CLASSIC worker (not a module worker): MediaPipe's WASM glue calls
  // importScripts() internally, which a module worker forbids. A classic worker
  // still supports the dynamic import() we use to pull the vision ESM bundle.
  const worker = new Worker(new URL("./poseWorker.ts", import.meta.url));
  let latest: Landmarks | null = null;
  let busy = false;
  let delegate: "GPU" | "CPU" = "GPU";

  // init handshake (with a timeout so a stuck worker doesn't hang Start forever)
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("pose worker init timeout")), 20000);
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m?.type === "ready") { delegate = m.delegate; clearTimeout(to); resolve(); }
      else if (m?.type === "error") { clearTimeout(to); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message || "pose worker error")); };
    worker.postMessage({ type: "init", visionEsm: VISION_ESM, wasmBase: WASM_BASE, modelUrl: MODELS[quality] ?? MODELS.full });
  });

  // steady state: stash each result, free the worker for the next frame
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m?.type === "result") { latest = (m.landmarks as Landmarks | null) ?? null; busy = false; }
  };
  worker.onerror = () => { busy = false; }; // never wedge on a transient worker error

  return {
    delegate,
    detect(video, tMs) {
      // Non-blocking: if the worker is idle, ship the current frame; always
      // return the last completed landmarks immediately (never block the UI).
      if (!busy && video.readyState >= 2) {
        busy = true;
        const ts = tMs;
        createImageBitmap(video)
          .then((bmp) => worker.postMessage({ type: "frame", bitmap: bmp, ts }, [bmp]))
          .catch(() => { busy = false; });
      }
      return latest;
    },
    close() {
      try { worker.terminate(); } catch { /* ignore */ }
    },
  };
}

export async function createPoseDetector(quality: PoseQuality = "full"): Promise<PoseDetector> {
  const vision = await loadVision();
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  let delegate: "GPU" | "CPU" = "GPU";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let landmarker: any;
  const make = async (d: "GPU" | "CPU") =>
    vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODELS[quality] ?? MODELS.full, delegate: d },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  // The GPU delegate often initializes lazily — createFromOptions can succeed
  // while the WebGL pipeline only fails on the first inference. Warm it up with
  // a throwaway frame at ts 0 so a broken GPU falls back to CPU at setup time,
  // not silently mid-session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const warmUp = (lm: any) => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    lm.detectForVideo(c, 0);
  };
  try {
    landmarker = await make("GPU");
    warmUp(landmarker);
  } catch {
    try { landmarker?.close?.(); } catch { /* ignore */ }
    delegate = "CPU";
    landmarker = await make("CPU");
    try { warmUp(landmarker); } catch { /* CPU warm-up best-effort */ }
  }

  let lastTs = 0; // warm-up consumed ts 0; real frames must exceed it
  return {
    delegate,
    detect(video, tMs) {
      // MediaPipe requires strictly increasing timestamps in VIDEO mode.
      let ts = Math.round(tMs);
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      // Let inference errors (e.g. lost WebGL context) propagate — the caller
      // counts consecutive failures and surfaces a recoverable error.
      const res = landmarker.detectForVideo(video, ts);
      const lms = res?.landmarks?.[0];
      if (!lms || !lms.length) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return lms.map((p: any) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })) as Landmarks;
    },
    close() {
      try {
        landmarker?.close?.();
      } catch {
        /* ignore */
      }
    },
  };
}
