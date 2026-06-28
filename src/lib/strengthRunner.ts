/**
 * Strength workout runner — a PURE state machine that walks a StrengthSession
 * set-by-set, auto-cycling set → rest → set, and a set of pure text generators
 * for the spoken coaching. Kept free of React/timers/Audio so it can be pinned
 * by a self-test; the hook ([[useStrengthRunner]]) drives it with a real clock
 * and the Form Lab UI turns its effects into speech, beeps and camera control.
 *
 * Flow per set:  briefing (standard + tempo + RIR/RPE, 3-2-1) → set (camera
 * counts; auto-ends at target reps, or the athlete/voice ends it) → rest
 * ("halfway" + final countdown) → next set's briefing → … → done.
 */

import type { SetReport } from "./repForm";
import { getExercise } from "./exercises";
import { setOrder, type StrengthSession, type StrengthSetSpec, type StrengthBlock } from "./strengthSession";
import { fmtLoad, type LoadUnit } from "./strengthHistory";

export type RunnerPhase = "idle" | "briefing" | "set" | "rest" | "done";

/** Side effects the reducer asks the host (Form Lab) to perform. */
export type RunnerEffect =
  | { kind: "camera"; on: boolean } // start/stop the rep-counting camera
  | { kind: "beep"; freq?: number } // countdown tick
  | { kind: "cue"; name: CueName } // host composes + speaks the matching line
  | { kind: "vibrate" };

export type CueName = "brief" | "go" | "rest_halfway" | "post_set" | "done";

export type RunnerAction =
  | { type: "START"; now: number }
  | { type: "TICK"; now: number }
  | { type: "REPS"; n: number; now: number }
  | { type: "END_SET"; now: number } // manual / voice "done"
  | { type: "SKIP_REST"; now: number } // voice "skip" / button
  | { type: "STOP" };

export interface RunnerState {
  session: StrengthSession;
  order: { block: number; set: number }[];
  pos: number; // index into order
  phase: RunnerPhase;
  reps: number; // reps counted in the current set
  phaseEndsAt: number | null; // epoch ms for timed phases (briefing/rest)
  /** one-shot cue guards, reset on entering a timed phase. */
  saidHalfway: boolean;
  lastTick: number; // last integer second announced in a countdown
  actuals: number[]; // actual reps recorded per order index
}

export const BRIEF_SEC = 5; // lead-in before each set (brief + 3-2-1)
const FINAL_COUNT = 3; // beep the last N seconds of rest / briefing

export function initRunner(session: StrengthSession): RunnerState {
  return {
    session,
    order: setOrder(session),
    pos: 0,
    phase: "idle",
    reps: 0,
    phaseEndsAt: null,
    saidHalfway: false,
    lastTick: 0,
    actuals: [],
  };
}

const result = (state: RunnerState, effects: RunnerEffect[] = []) => ({ state, effects });

/** Enter the briefing for the set at `pos` (camera off, brief cue, countdown armed). */
function enterBriefing(s: RunnerState, pos: number, now: number): { state: RunnerState; effects: RunnerEffect[] } {
  return result(
    { ...s, pos, phase: "briefing", reps: 0, phaseEndsAt: now + BRIEF_SEC * 1000, saidHalfway: false, lastTick: 99 },
    [{ kind: "camera", on: false }, { kind: "cue", name: "brief" }]
  );
}

/** Record the current set's reps and move on (rest / next briefing / done). */
function endSet(s: RunnerState, now: number): { state: RunnerState; effects: RunnerEffect[] } {
  const actuals = s.actuals.slice();
  actuals[s.pos] = s.reps;
  const spec = currentSpec(s);
  const isLast = s.pos >= s.order.length - 1;
  const base: RunnerState = { ...s, actuals };
  const effects: RunnerEffect[] = [{ kind: "camera", on: false }, { kind: "cue", name: "post_set" }];

  if (isLast) {
    return result({ ...base, phase: "done", phaseEndsAt: null }, [...effects, { kind: "cue", name: "done" }]);
  }
  // Always go to rest with `pos` UNCHANGED, so the camera-off log + post_set cue
  // describe the just-finished set (not the next one). A 0s rest (back-to-back /
  // superset) simply expires on the next TICK, which advances to pos+1's briefing.
  const restMs = Math.max(0, spec?.restSec ?? 0) * 1000;
  return result({ ...base, phase: "rest", phaseEndsAt: now + restMs, saidHalfway: false, lastTick: 99 }, effects);
}

export function runnerReducer(s: RunnerState, a: RunnerAction): { state: RunnerState; effects: RunnerEffect[] } {
  switch (a.type) {
    case "START": {
      if (s.order.length === 0) return result(s);
      return enterBriefing(s, 0, a.now);
    }

    case "REPS": {
      if (s.phase !== "set") return result(s);
      const reps = Math.max(s.reps, a.n);
      const spec = currentSpec(s);
      const target = spec?.targetReps ?? 0;
      if (target > 0 && reps >= target) {
        return endSet({ ...s, reps }, a.now); // auto-end at the rep target
      }
      return result({ ...s, reps });
    }

    case "END_SET": {
      if (s.phase !== "set") return result(s);
      return endSet(s, a.now);
    }

    case "SKIP_REST": {
      if (s.phase !== "rest") return result(s);
      return enterBriefing(s, s.pos + 1, a.now); // jump to the next set's briefing
    }

    case "TICK": {
      if (s.phaseEndsAt == null) return result(s);
      const remMs = s.phaseEndsAt - a.now;
      const remSec = Math.max(0, Math.ceil(remMs / 1000));
      const effects: RunnerEffect[] = [];

      // rest: announce halfway once
      let saidHalfway = s.saidHalfway;
      if (s.phase === "rest" && !saidHalfway) {
        const spec = currentSpec(s);
        const total = spec?.restSec ?? 0;
        if (total >= 20 && remSec <= Math.ceil(total / 2)) {
          effects.push({ kind: "cue", name: "rest_halfway" });
          saidHalfway = true;
        }
      }

      // final-seconds beeps (rest + briefing), one per second
      let lastTick = s.lastTick;
      if (remSec <= FINAL_COUNT && remSec >= 1 && remSec < lastTick) {
        effects.push({ kind: "beep", freq: 740 });
        lastTick = remSec;
      }

      if (remMs <= 0) {
        if (s.phase === "briefing") {
          return result(
            { ...s, phase: "set", phaseEndsAt: null, reps: 0, lastTick: 0 },
            [...effects, { kind: "beep", freq: 990 }, { kind: "camera", on: true }, { kind: "cue", name: "go" }]
          );
        }
        if (s.phase === "rest") {
          const next = enterBriefing({ ...s, saidHalfway, lastTick }, s.pos + 1, a.now);
          return result(next.state, [...effects, ...next.effects]);
        }
      }
      return result({ ...s, saidHalfway, lastTick }, effects);
    }

    case "STOP":
      return result({ ...s, phase: "idle", phaseEndsAt: null }, [{ kind: "camera", on: false }]);

    default:
      return result(s);
  }
}

/* ------------------------------------------------------------------ */
/* Selector + view                                                     */
/* ------------------------------------------------------------------ */

export interface RunnerView {
  phase: RunnerPhase;
  blockIndex: number;
  setIndex: number;
  exerciseId: string;
  exerciseName: string;
  spec: StrengthSetSpec | null;
  block: StrengthBlock | null;
  unit: LoadUnit;
  tempo: [number, number, number] | null;
  standard: string;
  setNumberInBlock: number;
  setsInBlock: number;
  blockNumber: number;
  totalBlocks: number;
  globalSetNumber: number;
  totalGlobalSets: number;
  completedSets: number;
  isLastSetOfBlock: boolean;
  isLastSetOfSession: boolean;
  reps: number;
  restLeftSec: number;
  briefLeftSec: number;
}

function currentSpec(s: RunnerState): StrengthSetSpec | null {
  const o = s.order[s.pos];
  if (!o) return null;
  return s.session.blocks[o.block]?.sets[o.set] ?? null;
}

export function runnerView(s: RunnerState, now: number): RunnerView {
  const o = s.order[s.pos] ?? { block: 0, set: 0 };
  const block = s.session.blocks[o.block] ?? null;
  const spec = block?.sets[o.set] ?? null;
  const ex = block ? getExercise(block.exerciseId) : null;
  const isLastOfBlock = block ? o.set === block.sets.length - 1 : false;
  const isLastOfSession = s.pos >= s.order.length - 1;
  const remMs = s.phaseEndsAt != null ? Math.max(0, s.phaseEndsAt - now) : 0;
  return {
    phase: s.phase,
    blockIndex: o.block,
    setIndex: o.set,
    exerciseId: block?.exerciseId ?? "",
    exerciseName: ex?.name ?? "Set",
    spec,
    block,
    unit: block?.unit ?? "kg",
    tempo: block?.tempo ?? null,
    standard: block?.standard ?? "",
    setNumberInBlock: o.set + 1,
    setsInBlock: block?.sets.length ?? 0,
    blockNumber: o.block + 1,
    totalBlocks: s.session.blocks.length,
    globalSetNumber: s.pos + 1,
    totalGlobalSets: s.order.length,
    completedSets: s.actuals.filter((x) => x != null).length,
    isLastSetOfBlock: isLastOfBlock,
    isLastSetOfSession: isLastOfSession,
    reps: s.reps,
    restLeftSec: s.phase === "rest" ? Math.ceil(remMs / 1000) : 0,
    briefLeftSec: s.phase === "briefing" ? Math.ceil(remMs / 1000) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Spoken-line generators (pure)                                       */
/* ------------------------------------------------------------------ */

/** Set-start briefing: standard + tempo + RIR/RPE. */
export function briefText(v: RunnerView): string {
  if (!v.spec) return "";
  const parts: string[] = [];
  parts.push(`Set ${v.setNumberInBlock} of ${v.setsInBlock}, ${v.exerciseName}.`);
  const w = v.spec.weight;
  if (w != null && w > 0) parts.push(`${fmtLoad(w, v.unit)}.`);
  parts.push(v.spec.targetReps > 0 ? `Target ${v.spec.targetReps} reps.` : `As many reps as you can.`);
  if (v.spec.rir != null) parts.push(`Leave ${v.spec.rir} in reserve.`);
  if (v.spec.rpe != null) parts.push(`Around R P E ${v.spec.rpe}.`);
  if (v.tempo) parts.push(`Tempo ${v.tempo[0]} down, ${v.tempo[1]} pause, ${v.tempo[2]} up.`);
  if (v.standard) parts.push(standardSentence(v.standard));
  return parts.join(" ");
}

/**
 * The spoken briefing only voices the FIRST standard cue (keeping the brief short
 * enough to finish before the set starts); the full multi-cue standard is shown
 * on the runner card. Caps at ~110 chars as a backstop.
 */
function standardSentence(note: string): string {
  const first = note.split(/(?<=[.!?])\s+/)[0] ?? note;
  return first.length > 110 ? first.slice(0, 107) + "…" : first;
}

/** Mid-rest reminder + what's next. */
export function restHalfwayText(v: RunnerView): string {
  const next = v.isLastSetOfBlock && !v.isLastSetOfSession ? "new exercise next" : `${v.exerciseName} next`;
  return `Halfway. ${v.restLeftSec} seconds. ${cap(next)}.`;
}

/**
 * Post-set summary: how many sets done, what to correct, and whether it's the
 * last set / round. `report` is the just-finished set (may be null if the camera
 * caught nothing). `v` is the view AT end-of-set (before advancing).
 */
export function postSetText(report: SetReport | null, v: RunnerView): string {
  const reps = report?.reps ?? v.reps;
  const parts: string[] = [`Set done. ${reps} ${reps === 1 ? "rep" : "reps"}.`];

  // corrections — the worst 1–2 faults across the set
  const faults = (report?.faults ?? []).filter((f) => f.severity !== "info").sort((a, b) => b.reps - a.reps).slice(0, 2);
  if (report && report.reps > 0 && faults.length === 0) {
    parts.push("Clean set.");
  } else {
    for (const f of faults) parts.push(`${cap(f.fault)} on ${f.reps} ${f.reps === 1 ? "rep" : "reps"} — ${lc(f.cue)}.`);
  }

  parts.push(`${v.completedSets} of ${v.totalGlobalSets} sets done.`);
  if (v.isLastSetOfSession) parts.push("That's the last set. Strong work.");
  else if (v.isLastSetOfBlock) parts.push(`Last set of ${v.exerciseName}. New exercise after this rest.`);
  return parts.join(" ");
}

/** End-of-workout line. */
export function doneText(v: RunnerView): string {
  return `Workout complete. ${v.completedSets} ${v.completedSets === 1 ? "set" : "sets"} logged. Great session.`;
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function lc(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/* ------------------------------------------------------------------ */
/* Dev self-test                                                       */
/* ------------------------------------------------------------------ */

export function selfTestStrengthRunner(): { ok: boolean; detail: string } {
  const checks: string[] = [];
  let ok = true;
  const expect = (cond: boolean, msg: string) => { if (!cond) { ok = false; checks.push("FAIL " + msg); } };

  // 1 block, 2 sets, target 3 reps, 30s rest.
  const session: StrengthSession = {
    id: "s", title: "T", createdAt: 0,
    blocks: [{
      id: "b", exerciseId: "back_squat", unit: "kg", tempo: [2, 1, 1], standard: "Hit parallel, drive up.",
      sets: [
        { targetReps: 3, weight: 80, restSec: 30, rir: 2, rpe: 8 },
        { targetReps: 3, weight: 80, restSec: 30, rir: 1, rpe: 9 },
      ],
    }],
  };
  let st = initRunner(session);
  let t = 1000;
  const step = (a: RunnerAction) => { const r = runnerReducer(st, a); st = r.state; return r.effects; };

  // START → briefing, camera off + brief cue
  let fx = step({ type: "START", now: t });
  expect(st.phase === "briefing", `start→briefing (${st.phase})`);
  expect(fx.some((e) => e.kind === "cue" && e.name === "brief"), "brief cue on start");
  expect(fx.some((e) => e.kind === "camera" && !e.on), "camera off during briefing");

  // tick to end of briefing → set + camera on + go cue
  t += BRIEF_SEC * 1000 + 10;
  fx = step({ type: "TICK", now: t });
  expect(st.phase === "set", `briefing→set (${st.phase})`);
  expect(fx.some((e) => e.kind === "camera" && e.on), "camera on entering set");
  expect(fx.some((e) => e.kind === "cue" && e.name === "go"), "go cue");

  // reps below target: no transition
  step({ type: "REPS", n: 2, now: t });
  expect(st.phase === "set" && st.reps === 2, "reps 2 holds in set");

  // hit target → auto end set → rest, post_set cue, actual recorded
  fx = step({ type: "REPS", n: 3, now: t });
  expect(st.phase === "rest", `target→rest (${st.phase})`);
  expect(st.actuals[0] === 3, "actual reps recorded");
  expect(fx.some((e) => e.kind === "cue" && e.name === "post_set"), "post_set cue");
  // post-set "sets done" counts the just-finished set (1, not 2) after set 1 of 2
  const postCount = postSetText({ exerciseId: "back_squat", exerciseName: "Back Squat", reps: 3, reps_detail: [], faults: [], avgTempo: null, cleanReps: 3, velCurve: [], velLossPct: null, velLossThreshold: null }, runnerView(st, t));
  expect(/1 of 2 sets done/.test(postCount), `post-set count "${postCount}"`);

  // tick to halfway (30s rest → halfway at 15s left)
  t += 16000;
  fx = step({ type: "TICK", now: t });
  expect(fx.some((e) => e.kind === "cue" && e.name === "rest_halfway"), "halfway cue");
  expect(st.saidHalfway, "halfway flagged once");
  // halfway not repeated
  fx = step({ type: "TICK", now: t + 500 });
  expect(!fx.some((e) => e.kind === "cue" && e.name === "rest_halfway"), "halfway not repeated");

  // tick past rest end → next set's briefing (pos advanced)
  t += 16000;
  fx = step({ type: "TICK", now: t });
  expect(st.phase === "briefing" && st.pos === 1, `rest→briefing set2 (${st.phase},pos${st.pos})`);

  // brief→set, then manual END_SET (AMRAP-style) ends the last set → done
  t += BRIEF_SEC * 1000 + 10;
  step({ type: "TICK", now: t });
  expect(st.phase === "set", "set2 started");
  step({ type: "REPS", n: 2, now: t });
  fx = step({ type: "END_SET", now: t });
  expect(st.phase === "done", `last END_SET→done (${st.phase})`);
  expect(fx.some((e) => e.kind === "cue" && e.name === "done"), "done cue");
  expect(st.actuals[1] === 2, "last set actual recorded");

  // restSec=0 (back-to-back): ending set 1 must keep pos on the FINISHED set so
  // the post_set cue + weight log describe it, then a tick advances to set 2.
  const superset: StrengthSession = {
    id: "s2", title: "T2", createdAt: 0,
    blocks: [{ id: "b2", exerciseId: "bench_press", unit: "kg", tempo: [2, 1, 1], standard: "Touch chest, lockout.",
      sets: [{ targetReps: 3, weight: 60, restSec: 0, rir: null, rpe: null }, { targetReps: 3, weight: 60, restSec: 0, rir: null, rpe: null }] }],
  };
  let ss = initRunner(superset);
  let st2 = ss; let tt = 1000;
  const step2 = (a: RunnerAction) => { const r = runnerReducer(st2, a); st2 = r.state; return r.effects; };
  step2({ type: "START", now: tt });
  tt += BRIEF_SEC * 1000 + 10; step2({ type: "TICK", now: tt });
  let fx2 = step2({ type: "END_SET", now: tt }); // end set 1 (restSec 0)
  expect(st2.phase === "rest" && st2.pos === 0, `0-rest: stays on finished set (${st2.phase},pos${st2.pos})`);
  expect(fx2.some((e) => e.kind === "cue" && e.name === "post_set"), "0-rest: post_set emitted on finished set");
  // post_set view reflects set 1 of 2 (not set 2)
  const v0rest = runnerView(st2, tt);
  expect(v0rest.setNumberInBlock === 1 && v0rest.spec?.weight === 60, "0-rest: post_set view is the finished set");
  tt += 250; step2({ type: "TICK", now: tt }); // 0s rest expires → next briefing
  expect(st2.phase === "briefing" && st2.pos === 1, `0-rest: advances to set 2 briefing (${st2.phase},pos${st2.pos})`);

  // text generators don't throw and include the essentials
  const v0 = runnerView(initRunner(session), 0);
  const brief = briefText(v0);
  expect(/Target 3 reps/.test(brief) && /reserve/.test(brief) && /Tempo/.test(brief), `brief text (${brief.slice(0, 40)}…)`);
  const post = postSetText({ exerciseId: "back_squat", exerciseName: "Back Squat", reps: 3, reps_detail: [], faults: [{ code: "trunk_lean", fault: "excessive forward lean", cue: "Chest up", severity: "warn", reliability: "ok", reps: 2 }], avgTempo: null, cleanReps: 1, velCurve: [], velLossPct: null, velLossThreshold: null }, v0);
  expect(/forward lean/i.test(post) && /sets done/.test(post), `post-set text (${post.slice(0, 40)}…)`);

  return { ok, detail: ok ? "START→brief→set→target→rest→halfway→set2→done; text ok" : checks.join("; ") };
}
