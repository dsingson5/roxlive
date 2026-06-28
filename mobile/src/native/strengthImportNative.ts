/**
 * Native hub-import — RN replacement for lib/strengthImport.ts's DOMParser path.
 * Uses node-html-parser (pure JS, no DOM) and an ABSOLUTE hub URL (native fetch
 * has no same-origin base + no CORS), but REUSES the web's pure parse helpers
 * (parseRepsTarget / parseRpe / cleanExerciseName) so the mapping can't drift.
 *
 * Only the DOM-walking loop is reimplemented here (querySelector → node-html-parser).
 */
import { parse } from "node-html-parser";
import { newSession, newBlock } from "@engine/strengthSession";
import { matchExercise } from "@engine/exercises";
import { parseRepsTarget, parseRpe, cleanExerciseName, type ImportResult, type StrengthLetter } from "@engine/strengthImport";

const HUB_BASE = "https://dsingson5.github.io/hybrid-crew";

// KEEP IN SYNC with NON_TRACKABLE in src/lib/strengthImport.ts — accessories the
// broad matchExercise catch-alls would mis-map (carries/holds/walks/throws/etc.).
const NON_TRACKABLE = /pallof|farmer|suitcase|\bcarry\b|plank|copenhagen|\bhold\b|\bwalk\b|throw|\bsled\b|l-?sit|airplane|pass-?through|med ?ball|leg swing|band pull|\bscap\b|high pull|hollow|handstand/i;

/** Parse a fetched strength page's HTML into a runnable session (node-html-parser). */
export function parseStrengthSessionNative(html: string, letter: string): ImportResult {
  const root = parse(html);
  const titleRaw = root.querySelector("title")?.text || `Strength ${letter}`;
  const titlePart = titleRaw.split("|")[0].replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const session = newSession(`Strength ${letter} · ${titlePart}`);
  const skipped: string[] = [];

  for (const card of root.querySelectorAll("details.exercise-card")) {
    const sets = parseInt(card.getAttribute("data-sets") || "0", 10);
    if (!Number.isFinite(sets) || sets < 1) continue; // warm-up / non-set card
    const name = cleanExerciseName(card.querySelector("h2")?.text || "");
    if (!name) continue;
    if (NON_TRACKABLE.test(name)) { skipped.push(name); continue; }
    const ex = matchExercise(name);
    if (!ex) { skipped.push(name); continue; }
    const targetReps = parseRepsTarget(card.querySelector(".reps")?.text || "") ?? 8;
    const restSec = parseInt(card.getAttribute("data-rest") || "90", 10) || 90;
    const rpe = parseRpe(card.querySelector(".rpe")?.text || "");
    const block = newBlock(ex.id, { sets, unit: "kg", set: { targetReps, weight: null, restSec, rir: null, rpe } });
    if (card.getAttribute("data-unilateral") === "true") block.standard = `Each side. ${block.standard}`;
    session.blocks.push(block);
  }
  return { session, skipped };
}

/** Fetch + parse a hub strength session (absolute URL, no CORS on native). */
export async function fetchStrengthSessionNative(letter: StrengthLetter, signal?: AbortSignal): Promise<ImportResult | null> {
  try {
    const res = await fetch(`${HUB_BASE}/strength-${letter}.html`, { signal });
    if (!res.ok) return null;
    return parseStrengthSessionNative(await res.text(), letter);
  } catch {
    return null;
  }
}
