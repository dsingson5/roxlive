/**
 * Import a hub Strength A/B/C/D session (or today's, via the calendar) into a
 * runnable {@link StrengthSession} (Stage 4).
 *
 * The hub strength pages (dsingson5.github.io/hybrid-crew/strength-A.html …) are
 * served from the SAME origin as RoxLive, and each exercise is STATIC markup:
 *   <details class="exercise-card" data-sets="4" data-rest="180" data-unilateral="false">
 *     <h2>Trap-Bar Deadlift <span class="alt">or front squat</span></h2>
 *     <div class="reps">4 × 4–5</div>
 *     <div class="rpe">RPE 8 · ~82–87% 1RM</div>
 *   </details>
 * so we can fetch + DOMParse it (no JS execution needed). Each card with
 * data-sets ≥ 1 whose movement maps to a rep-counter ruleset becomes a block;
 * carries / holds / throws (no ruleset) are skipped and reported. Load isn't
 * prescribed on the page (it's RPE/%1RM-driven), so weight is left blank for the
 * athlete to fill — the last-load memory pre-fills it from history.
 *
 * Mirrors lib/calendarImport.ts's same-origin fetch model; reuses its calendar
 * fetch to resolve which session is scheduled today.
 */

import { matchExercise } from "./exercises";
import { newSession, newBlock, type StrengthSession } from "./strengthSession";
import { calendarPageFor, resolveCrewUser } from "./user";
import { fetchCalendarWorkouts } from "./calendarImport";

export interface ImportResult {
  session: StrengthSession;
  /** movement names skipped because they have no rep-counter ruleset (carries, holds…). */
  skipped: string[];
}

export type StrengthLetter = "A" | "B" | "C" | "D";

// Movements with no rep-counter ruleset that broad catch-alls ("press"/"row")
// would otherwise mis-map — carries, holds, throws, walks, sleds, plank variants.
const NON_TRACKABLE = /pallof|farmer|suitcase|\bcarry\b|plank|copenhagen|\bhold\b|\bwalk\b|throw|\bsled\b|l-?sit|airplane|pass-?through|med ?ball|leg swing|band pull|\bscap\b|high pull|hollow|handstand/i;

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Primary movement from an <h2> — drop the "or …" alternate and trailing notes. */
export function cleanExerciseName(h2text: string): string {
  const t = decode(h2text);
  return t.split(/\s+or\s+|\s+·\s+|\s*\(/i)[0].trim();
}

/**
 * Target reps from a ".reps" string ("4 × 4–5", "3 × 6–8/leg") — the TOP of the
 * range (auto-end target; the athlete can stop early). Null when it isn't
 * rep-based ("4 × 30m" distance, "3 × 30s/side" time).
 */
export function parseRepsTarget(reps: string): number | null {
  const t = decode(reps).replace(/[–—]/g, "-");
  const after = t.split(/[×x]/i)[1] ?? t; // the part after "sets ×"
  // not rep-based: distance/time/cals/percent/colon-time/seconds-quote → leave reps unset
  if (/%|\bcals?\b|:\s*\d|\d\s*["”]|\d+\s*(?:m|km|s|sec|secs|min)\b/i.test(after)) return null;
  const range = after.match(/(\d+)\s*-\s*(\d+)/);
  if (range) return parseInt(range[2], 10);
  const one = after.match(/(\d+)/);
  return one ? parseInt(one[1], 10) : null;
}

/** RPE from a ".rpe" string ("RPE 8 · ~82–87% 1RM", "RPE 7–8") — top of the range, or null. */
export function parseRpe(rpe: string): number | null {
  const t = decode(rpe).replace(/[–—]/g, "-");
  const m = t.match(/RPE\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!m) return null;
  const v = parseInt(m[2] || m[1], 10);
  return v >= 1 && v <= 10 ? v : null;
}

/** Parse a fetched strength page's HTML into a runnable session. Pure (DOMParser). */
export function parseStrengthSession(html: string, letter: string): ImportResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const titleRaw = doc.querySelector("title")?.textContent || `Strength ${letter}`;
  const titlePart = decode(titleRaw.split("|")[0]);
  const session = newSession(`Strength ${letter} · ${titlePart}`);
  const skipped: string[] = [];

  for (const card of Array.from(doc.querySelectorAll("details.exercise-card"))) {
    const sets = parseInt(card.getAttribute("data-sets") || "0", 10);
    if (!Number.isFinite(sets) || sets < 1) continue; // warm-up / non-set card
    const name = cleanExerciseName(card.querySelector("h2")?.textContent || "");
    if (!name) continue;
    // Accessories the broad matchExercise catch-alls would FALSE-match (a Pallof
    // "press", an overhead "walk", a med-ball "throw"): these have no rep-counter
    // ruleset, so skip them up front rather than mis-mapping the lift.
    if (NON_TRACKABLE.test(name)) { skipped.push(name); continue; }
    const ex = matchExercise(name);
    if (!ex) { skipped.push(name); continue; } // carry / hold / throw — no rep-counter ruleset
    const targetReps = parseRepsTarget(card.querySelector(".reps")?.textContent || "") ?? 8;
    const restSec = parseInt(card.getAttribute("data-rest") || "90", 10) || 90;
    const rpe = parseRpe(card.querySelector(".rpe")?.textContent || "");
    const block = newBlock(ex.id, { sets, unit: "kg", set: { targetReps, weight: null, restSec, rir: null, rpe } });
    if (card.getAttribute("data-unilateral") === "true") block.standard = `Each side. ${block.standard}`;
    session.blocks.push(block);
  }
  return { session, skipped };
}

/**
 * Fetch + parse a hub strength session (same origin in production). null ONLY on
 * a real fetch/parse failure; a successfully-read page returns its ImportResult
 * even when nothing matched (blocks=[]) so the caller can tell "couldn't load"
 * apart from "loaded, but no trackable lifts".
 */
export async function fetchStrengthSession(letter: StrengthLetter, signal?: AbortSignal): Promise<ImportResult | null> {
  try {
    const res = await fetch(`../hybrid-crew/strength-${letter}.html`, { credentials: "omit", signal });
    if (!res.ok) return null;
    return parseStrengthSession(await res.text(), letter);
  } catch {
    return null;
  }
}

/** Which strength session (A–D) the current athlete's calendar schedules today, or null. */
export async function todaysStrengthLetter(signal?: AbortSignal): Promise<StrengthLetter | null> {
  const page = calendarPageFor(resolveCrewUser());
  if (!page) return null;
  const entries = await fetchCalendarWorkouts(page, signal);
  // ONLY a real today match — never fall back to an arbitrary day (every entry has
  // a dateLabel, so the old fallback always picked entries[0] = the wrong day).
  const today = entries.find((e) => e.isToday) ?? null;
  if (!today) return null;
  const m = `${today.title} ${today.summary ?? ""}`.match(/strength[\s-]?([A-D])\b/i);
  return m ? (m[1].toUpperCase() as StrengthLetter) : null;
}

/* ---------------- dev self-test ---------------- */

export function selfTestStrengthImport(): { ok: boolean; detail: string } {
  let ok = true;
  const checks: string[] = [];
  const expect = (c: boolean, m: string) => { if (!c) { ok = false; checks.push("FAIL " + m); } };

  const html = `<html><head><title>Forge &amp; Anvil — Lower-Heavy | Jakarta 2026</title></head><body>
    <details class="exercise-card" data-sets="0" data-rest="0" data-unilateral="false"><h2>Warm-up Flow</h2><div class="reps">5 min</div><div class="rpe">flow</div></details>
    <details class="exercise-card" data-sets="4" data-rest="180" data-unilateral="false"><h2>Trap-Bar Deadlift <span class="alt">or front squat</span></h2><div class="reps">4 × 4–5</div><div class="rpe">RPE 8 · ~82–87% 1RM</div></details>
    <details class="exercise-card" data-sets="3" data-rest="90" data-unilateral="true"><h2>Rear-Foot-Elevated Split Squat</h2><div class="reps">3 × 6–8/leg</div><div class="rpe">RPE 7–8</div></details>
    <details class="exercise-card" data-sets="4" data-rest="90" data-unilateral="false"><h2>Heavy Sled Push</h2><div class="reps">4 × 30m</div><div class="rpe">RPE 7</div></details>
  </body></html>`;

  const { session, skipped } = parseStrengthSession(html, "A");
  expect(session.blocks.length === 2, `2 blocks (${session.blocks.length})`);
  expect(skipped.length === 1 && /sled/i.test(skipped[0]), `sled skipped (${skipped.join(",")})`);
  expect(/Strength A · Forge & Anvil/.test(session.title), `title (${session.title})`);
  const b0 = session.blocks[0];
  expect(b0?.exerciseId === "trap_bar_deadlift" && b0.sets.length === 4, `trap-bar 4 sets (${b0?.exerciseId})`);
  expect(b0?.sets[0].targetReps === 5 && b0.sets[0].restSec === 180 && b0.sets[0].rpe === 8, `set0 5/180/rpe8 (${b0?.sets[0].targetReps}/${b0?.sets[0].restSec}/${b0?.sets[0].rpe})`);
  const b1 = session.blocks[1];
  expect(b1?.exerciseId === "rfe_split_squat" && b1.sets[0].targetReps === 8 && b1.sets[0].rpe === 8, `rfess 8/rpe8 (${b1?.exerciseId})`);
  expect(/each side/i.test(b1?.standard || ""), "rfess unilateral standard");

  expect(parseRepsTarget("4 × 4–5") === 5 && parseRepsTarget("3 × 6–8/leg") === 8 && parseRepsTarget("4 × 30m") === null && parseRepsTarget("3 × 30s/side") === null, "parseRepsTarget reps/dist");
  expect(parseRepsTarget("5 × 100%") === null && parseRepsTarget("4 × 30 cal") === null && parseRepsTarget("4 × :30") === null && parseRepsTarget('4 × 30"') === null, "parseRepsTarget cal/%/time");
  expect(parseRpe("RPE 7–8") === 8 && parseRpe("RPE 8 · ~82%") === 8 && parseRpe("flow") === null && parseRpe("80–100% BW") === null, "parseRpe");
  expect(cleanExerciseName("Trap-Bar Deadlift or front squat (alt)") === "Trap-Bar Deadlift", `cleanName (${cleanExerciseName("Trap-Bar Deadlift or front squat (alt)")})`);

  return { ok, detail: ok ? `2 blocks, 1 skipped, reps/rpe/name parsed` : checks.join("; ") };
}
