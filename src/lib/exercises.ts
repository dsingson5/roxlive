/**
 * Exercise rulesets — the DATA layer of the rep-count + form engine (repForm.ts).
 *
 * Each movement is described, not coded: a primary angle signal, a two-state rep
 * machine (topEnter/bottomEnter with a hysteresis gap), and CSCS/NSCA-mapped
 * form checks (named fault + corrective cue + severity + required view). Adding a
 * movement = adding an entry here. Frontal-plane checks (knee valgus) carry
 * reliability "low_2d" — weakly observable in 2D, shown as a coaching aid only.
 *
 * Thresholds follow the spec's per-exercise table (NSCA technique standards).
 */

import type { Exercise } from "./repForm";

export const EXERCISES: Exercise[] = [
  {
    id: "back_squat", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Back Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "depth (hips to knee height)", tempoPhases: ["eccentric", "bottom", "concentric"],
    note: "Film side-on for depth + trunk; front-on to check knees tracking over the toes.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit between your hips — hit parallel", severity: "info", view: "sagittal" },
      { code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 55, fault: "excessive forward lean", cue: "Chest up, drive the hips forward", severity: "warn", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out — spread the floor", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "front_squat", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Front Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "depth (hips to knee height)", note: "Elbows high, stay upright — a front squat is meant to be more vertical than a back squat.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit straight down — hit parallel", severity: "info", view: "sagittal" },
      { code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 45, fault: "torso tipping forward", cue: "Elbows up, chest tall", severity: "warn", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "goblet_squat", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Goblet Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 100,
    romLabel: "depth", note: "Elbows inside the knees at the bottom.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit deep — elbows to the knees", severity: "info", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "conventional_deadlift", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 75,
    romLabel: "lockout", note: "Film strictly side-on. 2D can't verify spine position — keep a flat, braced back; this counts reps + tempo, it doesn't grade your spine.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Stand tall — squeeze the glutes at the top", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "trap_bar_deadlift", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Trap-Bar Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "lockout", note: "Push the floor away, stand tall. Easier to keep upright than a barbell pull.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Finish tall — hips through", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "rdl", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Romanian Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "hinge depth", note: "Push the hips BACK, shins near vertical, minimal knee travel. Bar stays close. Neutral spine (2D can't verify — film side-on).",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Stand tall, squeeze glutes", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "walking_lunge", name: "Lunge", view: "either", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "front-thigh depth", note: "Front shin vertical, knee tracking over the foot, front thigh to parallel. Film front-on for knee tracking, side-on for trunk.",
    formChecks: [
      { code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 30, fault: "torso tipping forward", cue: "Stay tall through the trunk", severity: "warn", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 14, fault: "front knee caving", cue: "Track the knee over the foot", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "overhead_press", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Overhead Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 85,
    romLabel: "overhead lockout", note: "Press to full lockout, biceps by the ears; ribs down (no big back-lean).",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "didn't lock out overhead", cue: "Press all the way — finish with the elbows straight", severity: "info", view: "sagittal" },
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 100, fault: "short range at the bottom", cue: "Bring the bar back to the shoulders each rep", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "push_press", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Push Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 85,
    romLabel: "overhead lockout", note: "Dip-drive from the legs, then punch to full lockout overhead.",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "didn't lock out overhead", cue: "Punch to straight elbows overhead", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "bench_press", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Bench / Floor Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "full lockout", note: "Touch the chest, press to full lockout. Film side-on; 5-point contact isn't checkable in 2D.",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Press to straight arms", severity: "info", view: "sagittal" },
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 95, fault: "bar didn't reach the chest", cue: "Touch the chest each rep", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "bent_over_row", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Bent-Over Row", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "pull to the ribs", note: "Freeze the hips — torso shouldn't rise with each pull. Full ROM, elbow past the torso.",
    formChecks: [
      { code: "rom_pull", metric: "elbowAngle", at: "min", op: ">", value: 80, fault: "short pull", cue: "Row all the way to the ribs", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "pull_up", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Pull-Up", view: "either", primary: "elbowAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "chin over the bar", note: "Full hang at the bottom, chin over the bar at the top — no partial kipping. Side-on films the arm bend best.",
    formChecks: [
      { code: "rom_top", metric: "elbowAngle", at: "min", op: ">", value: 80, fault: "partial range", cue: "Pull the chin over the bar", severity: "info", view: "either" },
    ],
  },
  {
    id: "kb_swing", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Kettlebell Swing", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "hip snap", note: "Hinge — don't squat — and SNAP the hips to a tall finish (plank at the top), neutral spine.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft hip snap", cue: "Stand tall — squeeze the glutes hard at the top", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "hip_thrust", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Hip Thrust", view: "sagittal", primary: "hipAngle", topEnter: 165, bottomEnter: 110,
    romLabel: "full hip extension", note: "Full extension at the top (shoulder-hip-knee straight), ribs down — don't hyperextend the low back.",
    formChecks: [
      { code: "extension", metric: "hipAngle", at: "max", op: "<", value: 168, fault: "under-extending at the top", cue: "Squeeze the glutes to full extension, ribs down", severity: "warn", view: "sagittal" },
    ],
  },
  {
    id: "cossack_squat", name: "Cossack Squat", view: "frontal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "working-leg depth", note: "Film front-on. Sink onto the working leg; keep that knee tracking over the foot.",
    formChecks: [
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 16, fault: "working knee caving", cue: "Track the knee over the foot", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },

  /* --- Hyrox / functional ---
   * Note: checks here deliberately test the BOTTOM extreme (depth) or a
   * non-primary metric — both reliably captured. A "lockout at the top" check on
   * the primary signal is omitted because a rep only counts once the primary
   * reaches topEnter, so the top is unprovable from a completed rep; the `note`
   * coaches the lockout instead. */
  {
    id: "thruster", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Thruster", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "squat depth + overhead lockout", note: "One movement: squat to parallel, then drive straight into a full overhead lockout (finish with straight elbows, biceps by the ears). Reps are counted off the squat.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient squat depth", cue: "Hit parallel before you drive up", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "wall_ball", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Wall Ball", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 100,
    romLabel: "squat depth", note: "Reps counted off the squat. Hit depth, then stand and throw to the target — the throw/catch height isn't graded in 2D.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient squat depth", cue: "Hit parallel each rep before the throw", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "power_clean", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Power Clean", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "stand to full extension", note: "Film side-on. This counts the floor-to-stand cycle + tempo + bar-speed; 2D can't grade the bar path, catch or triple-extension timing — send a clip to your coach for technique.",
    formChecks: [],
  },
  {
    id: "power_snatch", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Power Snatch", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "stand to full extension", note: "Film side-on. Counts the floor-to-stand cycle + tempo + bar-speed only; the overhead catch and bar path need a coach's eye, not a 2D camera.",
    formChecks: [],
  },
  {
    id: "good_morning", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Good Morning", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 105,
    romLabel: "hinge depth", note: "Push the hips back, soft knees, flat braced back (2D can't verify the spine — film side-on). Drive the hips through to a tall finish each rep.",
    formChecks: [],
  },

  /* --- Bodyweight / accessory --- */
  {
    id: "push_up", velocity: { track: "hip", lossThresholdPct: 20 }, name: "Push-Up", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 110,
    romLabel: "chest to the floor", note: "Film side-on. Lower until the chest is near the floor and press to straight arms; keep a straight line from shoulders to heels — hips don't sag or pike.",
    formChecks: [
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 100, fault: "shallow depth", cue: "Lower until the chest is near the floor", severity: "info", view: "sagittal" },
      { code: "hip_line", metric: "hipAngle", at: "min", op: "<", value: 155, fault: "hips out of line (sag or pike)", cue: "Squeeze the glutes — one straight line, shoulders to heels", severity: "warn", view: "sagittal" },
    ],
  },
  {
    id: "dip", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Dip", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 110,
    romLabel: "depth", note: "Film side-on. Lower until the upper arms reach about parallel, then press to a full lockout. Don't dive deeper than your shoulders are comfortable with.",
    formChecks: [
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 100, fault: "shallow depth", cue: "Lower to about upper-arm parallel", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "bicep_curl", velocity: { track: "wrist", lossThresholdPct: 20 }, name: "Biceps Curl", view: "either", primary: "elbowAngle", topEnter: 140, bottomEnter: 80,
    romLabel: "full curl", note: "Pin the elbows to your sides — no swinging or leaning back. Curl all the way up, lower to nearly straight each rep.",
    formChecks: [
      { code: "rom_top", metric: "elbowAngle", at: "min", op: ">", value: 70, fault: "didn't curl all the way", cue: "Squeeze the bar all the way to the top", severity: "info", view: "either" },
    ],
  },
];

export const EXERCISE_BY_ID: Record<string, Exercise> = Object.fromEntries(EXERCISES.map((e) => [e.id, e]));

export function getExercise(id: string | null | undefined): Exercise | null {
  if (!id) return null;
  return EXERCISE_BY_ID[id] ?? null;
}

/** Best-effort: map a free-text movement label (from a calendar/plan) to a ruleset. */
export function matchExercise(label: string | null | undefined): Exercise | null {
  const t = (label || "").toLowerCase();
  if (!t) return null;
  if (EXERCISE_BY_ID[t]) return EXERCISE_BY_ID[t];
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  // Specific compound/Olympic/Hyrox names first, before the generic "squat"/"press" catch-alls.
  if (has("thruster")) return EXERCISE_BY_ID.thruster;
  if (has("wall ball", "wallball", "wall-ball")) return EXERCISE_BY_ID.wall_ball;
  if (has("snatch")) return EXERCISE_BY_ID.power_snatch;
  if (has("jerk")) return EXERCISE_BY_ID.push_press; // clean & jerk → count the overhead drive
  if (has("clean")) return EXERCISE_BY_ID.power_clean;
  if (has("good morning", "good-morning")) return EXERCISE_BY_ID.good_morning;
  if (has("front squat")) return EXERCISE_BY_ID.front_squat;
  if (has("goblet")) return EXERCISE_BY_ID.goblet_squat;
  if (has("cossack")) return EXERCISE_BY_ID.cossack_squat;
  if (has("squat")) return EXERCISE_BY_ID.back_squat;
  if (has("rdl", "romanian")) return EXERCISE_BY_ID.rdl;
  if (has("trap", "hex bar", "hex-bar")) return EXERCISE_BY_ID.trap_bar_deadlift;
  if (has("deadlift", "pull from floor")) return EXERCISE_BY_ID.conventional_deadlift;
  if (has("lunge", "split squat", "rfe")) return EXERCISE_BY_ID.walking_lunge;
  if (has("push press")) return EXERCISE_BY_ID.push_press;
  if (has("push-up", "push up", "pushup", "press-up", "press up")) return EXERCISE_BY_ID.push_up;
  if (has("overhead", "ohp", "shoulder press", "strict press", "military")) return EXERCISE_BY_ID.overhead_press;
  if (has("bench", "floor press")) return EXERCISE_BY_ID.bench_press;
  if (has("row")) return EXERCISE_BY_ID.bent_over_row;
  if (has("pull-up", "pull up", "pullup", "chin-up", "chin up")) return EXERCISE_BY_ID.pull_up;
  if (has("swing", "kettlebell", "kb swing")) return EXERCISE_BY_ID.kb_swing;
  if (has("hip thrust", "thrust", "bridge")) return EXERCISE_BY_ID.hip_thrust;
  if (has("dip")) return EXERCISE_BY_ID.dip;
  if (has("curl", "bicep", "biceps")) return EXERCISE_BY_ID.bicep_curl;
  if (has("press")) return EXERCISE_BY_ID.overhead_press;
  return null;
}
