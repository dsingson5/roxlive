/**
 * Workout history — completed sessions persisted to localStorage so the user
 * can review previous workouts. Capped to keep storage bounded; each entry is a
 * SessionSummary (already carries a downsampled series for the trace + .FIT).
 *
 * History is scoped to the signed-in Hybrid Crew athlete: each crew member keeps
 * their own list under "roxlive.history.v1.<user>", and anonymous sessions fall
 * back to the shared "roxlive.history.v1". The key is resolved per call so it is
 * always correct regardless of when the user signed in (see lib/user.ts).
 */

import type { SessionSummary } from "../types";
import { resolveCrewUser } from "./user";

const BASE_KEY = "roxlive.history.v1";
const MIGRATED_FLAG = "roxlive.history.migrated";
const MAX = 50;

/** localStorage key for the current athlete (per-user when signed in). */
function histKey(): string {
  const u = resolveCrewUser();
  return u ? `${BASE_KEY}.${u}` : BASE_KEY;
}

/**
 * One-time move of pre-scoping history (the bare BASE_KEY, written by the version
 * that shipped before per-user scoping) into the first crew athlete who signs in
 * on this device, so their existing workouts don't vanish. Moved (not copied) and
 * guarded by a global flag so a later signer can't re-inherit the same data; never
 * clobbers an existing per-user list. On a shared device the bare key belongs to
 * whoever used it first — first signer adopts it, which is the least-bad mapping.
 */
function migrateLegacyOnce(user: string): void {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
    const legacy = localStorage.getItem(BASE_KEY);
    if (!legacy) {
      localStorage.setItem(MIGRATED_FLAG, "1");
      return;
    }
    const perUser = `${BASE_KEY}.${user}`;
    if (!localStorage.getItem(perUser)) localStorage.setItem(perUser, legacy);
    localStorage.removeItem(BASE_KEY);
    localStorage.setItem(MIGRATED_FLAG, "1");
  } catch {
    /* leave legacy in place rather than risk loss; never throw on load */
  }
}

export function loadHistory(): SessionSummary[] {
  const user = resolveCrewUser();
  if (user) migrateLegacyOnce(user);
  try {
    const raw = localStorage.getItem(user ? `${BASE_KEY}.${user}` : BASE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SessionSummary[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(list: SessionSummary[]): void {
  const key = histKey();
  const capped = list.slice(0, MAX);
  // Try the full list, then progressively fewer entries until it fits the
  // storage quota. Always attempts at least the single-item and empty cases.
  for (let n = capped.length; n >= 1; n--) {
    try {
      localStorage.setItem(key, JSON.stringify(capped.slice(0, n)));
      return;
    } catch {
      /* too big — drop the oldest and retry */
    }
  }
  // Nothing fit — leave at most an empty list rather than stale data.
  try {
    localStorage.removeItem(key);
  } catch {
    /* give up silently */
  }
}

/** Prepend a finished session (most recent first). */
export function addToHistory(summary: SessionSummary): void {
  const list = loadHistory();
  list.unshift(summary);
  save(list);
}

export function deleteFromHistory(id: string): SessionSummary[] {
  const list = loadHistory().filter((s) => s.id !== id);
  save(list);
  return list;
}

/** Merge a partial update into a saved session (e.g. RPE logged after the fact). */
export function updateHistory(id: string, patch: Partial<SessionSummary>): SessionSummary[] {
  const list = loadHistory().map((s) => (s.id === id ? { ...s, ...patch } : s));
  save(list);
  return list;
}

export function clearHistory(): SessionSummary[] {
  try {
    localStorage.removeItem(histKey());
  } catch {
    /* ignore */
  }
  return [];
}
