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
