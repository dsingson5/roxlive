/**
 * MoveNet (17 COCO keypoints) → the web engine's BlazePose-indexed Landmarks.
 *
 * The shared rep/form engine (../../src/lib/repForm.ts) reads BlazePose landmark
 * indices (shoulder 11/12, elbow 13/14, wrist 15/16, hip 23/24, knee 25/26,
 * ankle 27/28). MoveNet returns 17 keypoints as a flat [y, x, score] triple per
 * keypoint, normalized to [0,1]. We remap to a sparse length-33 array so the
 * engine runs UNCHANGED on-device. Feet/heels aren't in MoveNet, so running
 * foot-strike is unavailable here — strength rep-counting only needs the joints
 * above, which MoveNet provides.
 */
import type { Landmark, Landmarks } from "@engine/gait";

// MoveNet COCO keypoint index → BlazePose index the engine expects.
const MOVENET_TO_BLAZE: Record<number, number> = {
  0: 0, // nose
  5: 11, 6: 12, // shoulders
  7: 13, 8: 14, // elbows
  9: 15, 10: 16, // wrists
  11: 23, 12: 24, // hips
  13: 25, 14: 26, // knees
  15: 27, 16: 28, // ankles
};

/** Minimum keypoint score to treat a joint as visible (MoveNet confidence). */
const MIN_SCORE = 0.3;

/**
 * Build the engine's Landmarks (length 33) from a MoveNet output triplet array
 * `[y0,x0,s0, y1,x1,s1, …]` (17×3 = 51 floats), normalized [0,1].
 */
export function moveNetToLandmarks(out: ArrayLike<number>): Landmarks {
  const lm: Landmarks = new Array(33) as Landmarks;
  for (let i = 0; i < 17; i++) {
    const blaze = MOVENET_TO_BLAZE[i];
    if (blaze === undefined) continue;
    const y = out[i * 3 + 0];
    const x = out[i * 3 + 1];
    const score = out[i * 3 + 2];
    const p: Landmark = { x, y, visibility: score };
    lm[blaze] = p;
  }
  return lm;
}

/** Mean visibility of the joints the strength engine relies on (HUD quality). */
export function poseQuality(lm: Landmarks): number {
  const idx = [11, 12, 23, 24, 25, 26, 27, 28];
  let sum = 0, n = 0;
  for (const i of idx) {
    const v = lm[i]?.visibility;
    if (v != null) { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

export { MIN_SCORE };
