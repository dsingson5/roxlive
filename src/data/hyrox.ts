/**
 * The HYROX race model: 8× (1 km run + functional station), plus per-station
 * coaching used by the live guide. Loads show Open and Pro (men's) standards;
 * targets are representative segment splits, not guarantees.
 */

import type { HyroxStation, PlannedSegment, AthleteProfile } from "../types";

export const STATIONS: HyroxStation[] = [
  {
    id: "ski",
    name: "SkiErg",
    short: "SKI",
    load: { open: "1000 m", pro: "1000 m" },
    guide: {
      pacing:
        "Open ~5–8s/500m slower than your fresh pace. Find a rhythm you can hold for all 1000 m — don't blow up in the first 250 m.",
      technique: [
        "Drive from the hips and lats, not the arms.",
        "Full hip hinge, finish with a slight crunch.",
        "Long stroke — let the handle return fully.",
        "Breathe out on the pull, in on the recovery.",
      ],
      mistakes: ["Arm-only pulling that gasses your grip", "Short, choppy strokes that spike HR"],
      exit: "Stand up under control, walk the first 5 steps, then settle into run cadence.",
      target: { open: "4:30", pro: "3:30" },
    },
  },
  {
    id: "sled-push",
    name: "Sled Push",
    short: "PUSH",
    load: { open: "152 kg · 50 m", pro: "202 kg · 50 m" },
    guide: {
      pacing:
        "Break 50 m into 4×12.5 m efforts. Short, sharp pushes beat one heroic shove that buries your legs.",
      technique: [
        "Low hips, arms long, body at ~45°.",
        "Short, powerful steps on the balls of the feet.",
        "Eyes down, keep constant pressure on the sled.",
        "Reset hands high on the posts for leverage.",
      ],
      mistakes: ["Standing too upright (no drive)", "Letting the sled stop fully between pushes"],
      exit: "Legs will be lead — shake them out, take the first 100 m of the run easy.",
      target: { open: "3:00", pro: "2:15" },
    },
  },
  {
    id: "sled-pull",
    name: "Sled Pull",
    short: "PULL",
    load: { open: "103 kg · 50 m", pro: "153 kg · 50 m" },
    guide: {
      pacing:
        "Hand-over-hand, full extension each pull. Reset your feet, sit back, and use bodyweight — not just arms.",
      technique: [
        "Sit back low, drive heels into the floor.",
        "Pull rope to hip, hand over hand, no slack.",
        "Use a wide base and lean your weight back.",
        "Keep the rope moving — momentum is your friend.",
      ],
      mistakes: ["Pulling with bent-over back and arms only", "Standing tall and losing leverage"],
      exit: "Grip will be cooked before the next run — relax your hands and breathe.",
      target: { open: "3:30", pro: "2:30" },
    },
  },
  {
    id: "burpee-bj",
    name: "Burpee Broad Jumps",
    short: "BURP",
    load: { open: "80 m", pro: "80 m" },
    guide: {
      pacing:
        "The great equalizer. Smooth and steady — one breath per rep. Jump for distance, not height, to cover 80 m in fewer reps.",
      technique: [
        "Chest to floor, then explode up.",
        "Land soft and balanced, no extra hop.",
        "Maximize broad-jump distance each rep.",
        "Keep a metronome rhythm — never sprint it.",
      ],
      mistakes: ["Going anaerobic early and stalling", "Tiny jumps that add reps"],
      exit: "HR will be sky-high — control breathing for the first 200 m of the run.",
      target: { open: "5:00", pro: "3:30" },
    },
  },
  {
    id: "row",
    name: "Rowing",
    short: "ROW",
    load: { open: "1000 m", pro: "1000 m" },
    guide: {
      pacing:
        "Target a split ~3–5s/500m off your fresh 1k pace. Legs–back–arms, then reverse. Use it as 'active recovery' for your grip.",
      technique: [
        "Drive with the legs first, then open the back.",
        "Arms finish to the lower ribs.",
        "Strong drive, relaxed recovery (1:2 ratio).",
        "Keep stroke rate ~26–30 spm.",
      ],
      mistakes: ["Yanking with arms early", "Rushing the recovery and spiking HR"],
      exit: "Step off carefully — legs reload before you run again.",
      target: { open: "4:30", pro: "3:30" },
    },
  },
  {
    id: "farmers",
    name: "Farmers Carry",
    short: "CARRY",
    load: { open: "2×24 kg · 200 m", pro: "2×32 kg · 200 m" },
    guide: {
      pacing:
        "Pick them up and GO. The fastest station to make up time — limit grip resets to one or two max.",
      technique: [
        "Tall posture, shoulders back and down.",
        "Brace the core, walk with quick turnover.",
        "Crush-grip the handles, thumbs wrapped.",
        "Look ahead, breathe rhythmically.",
      ],
      mistakes: ["Setting the bells down repeatedly", "Shuffling slowly to 'save grip'"],
      exit: "Hands will be screaming — flick them out and roll into the run.",
      target: { open: "2:30", pro: "1:45" },
    },
  },
  {
    id: "lunges",
    name: "Sandbag Lunges",
    short: "LUNGE",
    load: { open: "20 kg · 100 m", pro: "30 kg · 100 m" },
    guide: {
      pacing:
        "Grindy and quad-burning. Settle into a sustainable cadence — knee taps the floor every rep, no rushing into failure.",
      technique: [
        "Sandbag high on the back of the shoulders.",
        "Long step, back knee gently taps the floor.",
        "Drive through the front heel to stand.",
        "Stay tall — don't fold over the bag.",
      ],
      mistakes: ["Short, choppy lunges (no knee tap = no-rep)", "Going too fast and blowing the quads"],
      exit: "Quads will be molten — the last run is mental. Short, quick steps.",
      target: { open: "4:30", pro: "3:15" },
    },
  },
  {
    id: "wall-balls",
    name: "Wall Balls",
    short: "WALL",
    load: { open: "100 reps · 6 kg", pro: "100 reps · 9 kg" },
    guide: {
      pacing:
        "The final boss. Break into manageable sets (e.g. 25/25/25/25 or 10s) from the start — never go to failure and lose your rhythm.",
      technique: [
        "Full squat below parallel every rep.",
        "Drive up and use leg power to launch the ball.",
        "Hit the target consistently (no-reps cost time).",
        "Catch soft and drop straight into the next squat.",
      ],
      mistakes: ["Big unbroken sets that force long rests", "Half-squats that get no-repped"],
      exit: "This is the finish — empty the tank on the last set and sprint the line.",
      target: { open: "6:30", pro: "4:30" },
    },
  },
];

/** Representative run split (compromised running) per division. */
const RUN_TARGET = { open: "5:00", pro: "3:50" };

/** Demo segment durations (compressed) so a full race plays in ~10 min. */
const DEMO_RUN_SEC = 38;
const DEMO_STATION_SEC = 30;

export function buildRace(): PlannedSegment[] {
  const segs: PlannedSegment[] = [];
  let index = 0;
  for (let i = 0; i < STATIONS.length; i++) {
    segs.push({
      index: index++,
      kind: "run",
      label: `Run ${i + 1}`,
      plannedSec: DEMO_RUN_SEC,
    });
    const st = STATIONS[i];
    segs.push({
      index: index++,
      kind: "station",
      label: st.name,
      station: st,
      plannedSec: DEMO_STATION_SEC,
    });
  }
  return segs;
}

export function runTarget(division: AthleteProfile["division"]): string {
  return division === "pro" ? RUN_TARGET.pro : RUN_TARGET.open;
}

/** Total runs distance is fixed: 8 km. Station distances vary. */
export const TOTAL_RUN_KM = 8;
