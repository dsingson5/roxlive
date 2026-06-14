/**
 * Workout history — completed sessions persisted to localStorage so the user
 * can review previous workouts. Capped to keep storage bounded; each entry is a
 * SessionSummary (already carries a downsampled series for the trace + .FIT).
 *
 * History is scoped to the signed-in Hybrid Crew athlete: each crew member keeps
 * their own list under "roxlive.history.v1.<user>", and anonymous sessions fall
 * back to the shared "roxlive.history.v1". The key is resolved per call so it is
 * always correct regardless of when the user signed in (see lib/user.ts).
 *
 * When cross-device sync is configured (lib/sync.ts) every write is mirrored to a
 * Cloudflare Worker. Deletes are recorded as tombstones (id -> deletedAt) and
 * sent alongside the sessions so the server-side union can't resurrect a removed
 * workout. pullAndMerge() folds the cloud copy back in.
 */

import type { SessionSummary } from "../types";
import { resolveCrewUser } from "./user";
import { pushHistorySoon, pullHistory, mergeHistory, mergeTombstones, type Tombstones } from "./sync";

const BASE_KEY = "roxlive.history.v1";
const TOMB_KEY = "roxlive.history.tomb.v1";
const MIGRATED_FLAG = "roxlive.history.migrated";
const MAX = 50;
const TOMB_MAX = 1000;

/** localStorage key for an athlete (per-user when signed in, else shared/anon). */
function keyFor(user: string | null): string {
  return user ? `${BASE_KEY}.${user}` : BASE_KEY;
}
function tombKeyFor(user: string | null): string {
  return user ? `${TOMB_KEY}.${user}` : TOMB_KEY;
}

function loadTomb(user: string | null): Tombstones {
  try {
    const raw = localStorage.getItem(tombKeyFor(user));
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Tombstones) : {};
  } catch {
    return {};
  }
}
function saveTomb(user: string | null, tomb: Tombstones): void {
  try {
    let entries = Object.entries(tomb);
    if (entries.length > TOMB_MAX) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, TOMB_MAX);
    localStorage.setItem(tombKeyFor(user), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
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
    const raw = localStorage.getItem(keyFor(user));
    if (!raw) return [];
    const arr = JSON.parse(raw) as SessionSummary[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(list: SessionSummary[]): void {
  const user = resolveCrewUser();
  const key = keyFor(user);
  const capped = list.slice(0, MAX);
  let stored = false;
  // Try the full list, then progressively fewer entries until it fits the
  // storage quota. Always attempts at least the single-item and empty cases.
  for (let n = capped.length; n >= 1; n--) {
    try {
      localStorage.setItem(key, JSON.stringify(capped.slice(0, n)));
      stored = true;
      break;
    } catch {
      /* too big — drop the oldest and retry */
    }
  }
  if (!stored) {
    // Nothing fit (or the list is empty) — leave no stale data behind.
    try {
      localStorage.removeItem(key);
    } catch {
      /* give up silently */
    }
  }
  // Mirror to the cloud (no-op unless sync configured). Tombstones travel along
  // so a server-side union can't resurrect a session deleted on this device.
  pushHistorySoon(user, capped, loadTomb(user));
}

/** Prepend a finished session (most recent first). */
export function addToHistory(summary: SessionSummary): void {
  const list = loadHistory();
  list.unshift(summary);
  save(list);
}

export function deleteFromHistory(id: string): SessionSummary[] {
  const user = resolveCrewUser();
  const tomb = loadTomb(user);
  tomb[id] = Date.now(); // remember the delete so sync won't bring it back
  saveTomb(user, tomb);
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

/** Replace the whole list (used after a cloud pull+merge). Persists + syncs. */
export function replaceHistory(list: SessionSummary[]): SessionSummary[] {
  save(list);
  return list.slice(0, MAX);
}

export function clearHistory(): SessionSummary[] {
  const user = resolveCrewUser();
  const now = Date.now();
  const tomb = loadTomb(user);
  for (const s of loadHistory()) tomb[s.id] = now; // tombstone everything we drop
  saveTomb(user, tomb);
  try {
    localStorage.removeItem(keyFor(user));
  } catch {
    /* ignore */
  }
  // Propagate the clear (empty list + tombstones) to the cloud (no-op if off).
  pushHistorySoon(user, [], tomb);
  return [];
}

/** Cheap content signature (ids + RPE) to detect a no-op merge and skip pushing. */
function sig(list: SessionSummary[]): string {
  return list
    .map((s) => `${s.id}:${s.rpe?.overall ?? ""}:${s.rpe?.perSegment ? Object.entries(s.rpe.perSegment).sort().join(",") : ""}`)
    .join("|");
}

/**
 * Pull the cloud copy for the signed-in athlete, merge it with local (union by
 * id, tombstones applied, richer RPE), persist + push the result, and return the
 * merged list. No-op (returns local) when sync is off or nothing changed, so an
 * unchanged History-open doesn't trigger a redundant push.
 */
export async function pullAndMerge(): Promise<SessionSummary[]> {
  const user = resolveCrewUser();
  const remote = await pullHistory(user);
  const local = loadHistory();
  if (!remote) return local;
  const localTomb = loadTomb(user);
  const mergedTomb = mergeTombstones(localTomb, remote.tombstones);
  const merged = mergeHistory(local, remote.sessions, mergedTomb);
  const tombChanged = JSON.stringify(localTomb) !== JSON.stringify(mergedTomb);
  if (sig(merged) === sig(local) && !tombChanged) return local; // nothing new — don't re-push
  saveTomb(user, mergedTomb);
  save(merged); // persists locally + pushes the union (with tombstones) back
  return merged.slice(0, MAX);
}
