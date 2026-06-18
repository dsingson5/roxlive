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
    id: "back_squat", name: "Back Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "depth (hips to knee height)", tempoPhases: ["eccentric", "bottom", "concentric"],
    note: "Film side-on for depth + trunk; front-on to check knees tracking over the toes.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit between your hips — hit parallel", severity: "info", view: "sagittal" },
      { code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 55, fault: "excessive forward lean", cue: "Chest up, drive the hips forward", severity: "warn", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out — spread the floor", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "front_squat", name: "Front Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "depth (hips to knee height)", note: "Elbows high, stay upright — a front squat is meant to be more vertical than a back squat.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit straight down — hit parallel", severity: "info", view: "sagittal" },
      { code: "trunk_lean", metric: "trunkLean", at: "max", op: ">", value: 45, fault: "torso tipping forward", cue: "Elbows up, chest tall", severity: "warn", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "goblet_squat", name: "Goblet Squat", view: "sagittal", primary: "kneeAngle", topEnter: 160, bottomEnter: 100,
    romLabel: "depth", note: "Elbows inside the knees at the bottom.",
    formChecks: [
      { code: "depth", metric: "depthHipKnee", at: "max", op: "<", value: 0, fault: "insufficient depth", cue: "Sit deep — elbows to the knees", severity: "info", view: "sagittal" },
      { code: "knee_valgus", metric: "kneeValgusPct", at: "max", op: ">", value: 12, fault: "knees caving in", cue: "Knees out", severity: "warn", view: "frontal", reliability: "low_2d" },
    ],
  },
  {
    id: "conventional_deadlift", name: "Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 75,
    romLabel: "lockout", note: "Film strictly side-on. 2D can't verify spine position — keep a flat, braced back; this counts reps + tempo, it doesn't grade your spine.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Stand tall — squeeze the glutes at the top", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "trap_bar_deadlift", name: "Trap-Bar Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "lockout", note: "Push the floor away, stand tall. Easier to keep upright than a barbell pull.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Finish tall — hips through", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "rdl", name: "Romanian Deadlift", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 95,
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
    id: "overhead_press", name: "Overhead Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 85,
    romLabel: "overhead lockout", note: "Press to full lockout, biceps by the ears; ribs down (no big back-lean).",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "didn't lock out overhead", cue: "Press all the way — finish with the elbows straight", severity: "info", view: "sagittal" },
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 100, fault: "short range at the bottom", cue: "Bring the bar back to the shoulders each rep", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "push_press", name: "Push Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 85,
    romLabel: "overhead lockout", note: "Dip-drive from the legs, then punch to full lockout overhead.",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "didn't lock out overhead", cue: "Punch to straight elbows overhead", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "bench_press", name: "Bench / Floor Press", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 80,
    romLabel: "full lockout", note: "Touch the chest, press to full lockout. Film side-on; 5-point contact isn't checkable in 2D.",
    formChecks: [
      { code: "lockout", metric: "elbowAngle", at: "max", op: "<", value: 165, fault: "soft lockout", cue: "Press to straight arms", severity: "info", view: "sagittal" },
      { code: "rom_bottom", metric: "elbowAngle", at: "min", op: ">", value: 95, fault: "bar didn't reach the chest", cue: "Touch the chest each rep", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "bent_over_row", name: "Bent-Over Row", view: "sagittal", primary: "elbowAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "pull to the ribs", note: "Freeze the hips — torso shouldn't rise with each pull. Full ROM, elbow past the torso.",
    formChecks: [
      { code: "rom_pull", metric: "elbowAngle", at: "min", op: ">", value: 80, fault: "short pull", cue: "Row all the way to the ribs", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "pull_up", name: "Pull-Up", view: "either", primary: "elbowAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "chin over the bar", note: "Full hang at the bottom, chin over the bar at the top — no partial kipping. Side-on films the arm bend best.",
    formChecks: [
      { code: "rom_top", metric: "elbowAngle", at: "min", op: ">", value: 80, fault: "partial range", cue: "Pull the chin over the bar", severity: "info", view: "either" },
    ],
  },
  {
    id: "kb_swing", name: "Kettlebell Swing", view: "sagittal", primary: "hipAngle", topEnter: 160, bottomEnter: 95,
    romLabel: "hip snap", note: "Hinge — don't squat — and SNAP the hips to a tall finish (plank at the top), neutral spine.",
    formChecks: [
      { code: "lockout", metric: "hipAngle", at: "max", op: "<", value: 165, fault: "soft hip snap", cue: "Stand tall — squeeze the glutes hard at the top", severity: "info", view: "sagittal" },
    ],
  },
  {
    id: "hip_thrust", name: "Hip Thrust", view: "sagittal", primary: "hipAngle", topEnter: 165, bottomEnter: 110,
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
  if (has("front squat")) return EXERCISE_BY_ID.front_squat;
  if (has("goblet")) return EXERCISE_BY_ID.goblet_squat;
  if (has("cossack")) return EXERCISE_BY_ID.cossack_squat;
  if (has("squat")) return EXERCISE_BY_ID.back_squat;
  if (has("rdl", "romanian")) return EXERCISE_BY_ID.rdl;
  if (has("trap", "hex bar", "hex-bar")) return EXERCISE_BY_ID.trap_bar_deadlift;
  if (has("deadlift", "pull from floor")) return EXERCISE_BY_ID.conventional_deadlift;
  if (has("lunge", "split squat", "rfe")) return EXERCISE_BY_ID.walking_lunge;
  if (has("push press")) return EXERCISE_BY_ID.push_press;
  if (has("overhead", "ohp", "shoulder press", "strict press", "military")) return EXERCISE_BY_ID.overhead_press;
  if (has("bench", "floor press")) return EXERCISE_BY_ID.bench_press;
  if (has("row")) return EXERCISE_BY_ID.bent_over_row;
  if (has("pull-up", "pull up", "pullup", "chin-up", "chin up")) return EXERCISE_BY_ID.pull_up;
  if (has("swing", "kettlebell", "kb swing")) return EXERCISE_BY_ID.kb_swing;
  if (has("hip thrust", "thrust", "bridge")) return EXERCISE_BY_ID.hip_thrust;
  if (has("press")) return EXERCISE_BY_ID.overhead_press;
  return null;
}
