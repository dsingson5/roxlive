/**
 * Strength-session model — the prescription a Form Lab strength *workout* runs.
 *
 * A session is an ordered list of exercise BLOCKS; each block is one movement
 * with a list of SET specs (target reps, weight, rest, RIR/RPE, tempo). The
 * Form Lab runner ([[strengthRunner]]) walks this structure, auto-cycling
 * set → rest → set with spoken coaching. Sessions can be built by hand or
 * imported from the hub Strength A–D / calendar pages (a later stage), so the
 * shape here is deliberately plain JSON that survives a localStorage round-trip.
 *
 * Scoped to the signed-in crew athlete (lib/user.ts) like the rest of the
 * per-athlete state — see the per-user-scoping memory.
 */

import type { LoadUnit } from "./strengthHistory";
import { getExercise } from "./exercises";
import { resolveCrewUser } from "./user";

/** One prescribed set within a block. */
export interface StrengthSetSpec {
  /** the rep target that auto-ends the set (0 = open / AMRAP — never auto-ends). */
  targetReps: number;
  /** working weight in the block's unit; null = bodyweight / not set. */
  weight: number | null;
  /** rest AFTER this set, seconds. */
  restSec: number;
  /** reps-in-reserve cue (null = not prescribed). */
  rir: number | null;
  /** RPE cue (null = not prescribed). */
  rpe: number | null;
}

/** One movement and its sets. */
export interface StrengthBlock {
  id: string;
  exerciseId: string;
  unit: LoadUnit;
  /** target [eccentric, pause, concentric] seconds, or null for "by feel". */
  tempo: [number, number, number] | null;
  /** spoken movement standard; defaults from the exercise's coaching cues. */
  standard: string;
  sets: StrengthSetSpec[];
}

export interface StrengthSession {
  id: string;
  title: string;
  blocks: StrengthBlock[];
  createdAt: number;
}

const DEFAULT_TEMPO: [number, number, number] = [2, 1, 1];
const DEFAULT_REST = 120;
const DEFAULT_REPS = 8;

let idSeq = 0;
function uid(prefix: string): string {
  idSeq += 1;
  // performance.now keeps ids unique without Date.now (unavailable in workflows/self-test contexts)
  return `${prefix}-${Math.round(performance.now())}-${idSeq}`;
}

/**
 * A movement's default spoken EXECUTION standard — built from its own coaching
 * cues (ROM/info cues first — depth, lockout — then the key fault cues), NOT the
 * camera-setup `note`. e.g. Back Squat → "Sit between your hips — hit parallel.
 * Chest up, drive the hips forward. Knees out — spread the floor."
 */
export function defaultStandard(exerciseId: string): string {
  const ex = getExercise(exerciseId);
  if (!ex) return "";
  const info = ex.formChecks.filter((c) => c.severity === "info").map((c) => c.cue);
  const warn = ex.formChecks.filter((c) => c.severity !== "info").map((c) => c.cue);
  const cues = [...info, ...warn].slice(0, 3);
  if (cues.length) return cues.map((c) => (/[.!?]$/.test(c) ? c : c + ".")).join(" ");
  return ex.romLabel ? ex.romLabel.charAt(0).toUpperCase() + ex.romLabel.slice(1) + "." : "";
}

export function newSet(partial?: Partial<StrengthSetSpec>): StrengthSetSpec {
  return {
    targetReps: partial?.targetReps ?? DEFAULT_REPS,
    weight: partial?.weight ?? null,
    restSec: partial?.restSec ?? DEFAULT_REST,
    rir: partial?.rir ?? null,
    rpe: partial?.rpe ?? null,
  };
}

export function newBlock(exerciseId: string, opts?: { sets?: number; unit?: LoadUnit; set?: Partial<StrengthSetSpec> }): StrengthBlock {
  const n = Math.max(1, opts?.sets ?? 3);
  return {
    id: uid("blk"),
    exerciseId,
    unit: opts?.unit ?? "kg",
    tempo: DEFAULT_TEMPO,
    standard: defaultStandard(exerciseId),
    sets: Array.from({ length: n }, () => newSet(opts?.set)),
  };
}

export function newSession(title = "Strength workout"): StrengthSession {
  return { id: uid("ses"), title, blocks: [], createdAt: Math.round(performance.timeOrigin + performance.now()) };
}

/**
 * Set a weight on one set AND propagate it forward — editing set i's weight
 * carries to every later set in the same block (the athlete's requested
 * behaviour: "change one set's weight → future sets change too"). Earlier sets
 * are untouched. Returns a NEW block (immutable update).
 */
export function propagateWeight(block: StrengthBlock, fromIndex: number, weight: number | null): StrengthBlock {
  if (fromIndex < 0 || fromIndex >= block.sets.length) return block;
  return {
    ...block,
    sets: block.sets.map((s, i) => (i >= fromIndex ? { ...s, weight } : s)),
  };
}

/** Total prescribed sets across the session. */
export function totalSets(session: StrengthSession): number {
  return session.blocks.reduce((a, b) => a + b.sets.length, 0);
}

/** Flatten to a linear walk order of (blockIndex, setIndex) for the runner. */
export function setOrder(session: StrengthSession): { block: number; set: number }[] {
  const out: { block: number; set: number }[] = [];
  session.blocks.forEach((b, bi) => b.sets.forEach((_, si) => out.push({ block: bi, set: si })));
  return out;
}

/* ---------------- persistence (per athlete) ---------------- */

const SESSION_KEY = "roxlive.strength.session.v1";
const keyFor = (): string => `${SESSION_KEY}:${resolveCrewUser() ?? "anon"}`;

export function saveSession(session: StrengthSession | null): void {
  try {
    if (session) localStorage.setItem(keyFor(), JSON.stringify(session));
    else localStorage.removeItem(keyFor());
  } catch {
    /* ignore */
  }
}

export function loadSession(): StrengthSession | null {
  try {
    const raw = localStorage.getItem(keyFor());
    if (!raw) return null;
    const s = JSON.parse(raw) as StrengthSession;
    if (s && Array.isArray(s.blocks)) return s;
  } catch {
    /* ignore */
  }
  return null;
}

/* ---------------- dev self-test ---------------- */

export function selfTestStrengthSession(): { ok: boolean; detail: string } {
  const checks: string[] = [];
  let ok = true;
  const expect = (cond: boolean, msg: string) => { if (!cond) { ok = false; checks.push("FAIL " + msg); } };

  const blk = newBlock("back_squat", { sets: 4, unit: "kg", set: { targetReps: 5, weight: 80, restSec: 150, rir: 2 } });
  expect(blk.sets.length === 4, `4 sets (${blk.sets.length})`);
  expect(blk.sets.every((s) => s.weight === 80 && s.targetReps === 5 && s.rir === 2), "set defaults applied");
  expect(blk.standard.length > 0 && /hit parallel|knees out|chest up/i.test(blk.standard), "standard derived from exercise cues");

  // propagate from set index 1 → sets 1..3 become 85, set 0 stays 80
  const p = propagateWeight(blk, 1, 85);
  expect(p.sets[0].weight === 80, "set 0 unchanged");
  expect(p.sets[1].weight === 85 && p.sets[2].weight === 85 && p.sets[3].weight === 85, "sets 1..3 propagated to 85");
  expect(blk.sets[1].weight === 80, "original block not mutated");

  const ses = newSession("Test");
  ses.blocks.push(blk, newBlock("bench_press", { sets: 3 }));
  expect(totalSets(ses) === 7, `total sets 7 (${totalSets(ses)})`);
  expect(setOrder(ses).length === 7 && setOrder(ses)[4].block === 1, "set order flattened");

  // out-of-range propagate is a no-op (returns same block)
  expect(propagateWeight(blk, 9, 100) === blk, "oob propagate no-op");

  return { ok, detail: ok ? `block=4sets total=${totalSets(ses)} propagate ok` : checks.join("; ") };
}
