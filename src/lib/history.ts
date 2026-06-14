/**
 * Workout history — completed sessions persisted to localStorage so the user
 * can review previous workouts. Capped to keep storage bounded; each entry is a
 * SessionSummary (already carries a downsampled series for the trace + .FIT).
 */

import type { SessionSummary } from "../types";

const KEY = "roxlive.history.v1";
const MAX = 50;

export function loadHistory(): SessionSummary[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SessionSummary[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(list: SessionSummary[]): void {
  const capped = list.slice(0, MAX);
  // Try the full list, then progressively fewer entries until it fits the
  // storage quota. Always attempts at least the single-item and empty cases.
  for (let n = capped.length; n >= 1; n--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(capped.slice(0, n)));
      return;
    } catch {
      /* too big — drop the oldest and retry */
    }
  }
  // Nothing fit — leave at most an empty list rather than stale data.
  try {
    localStorage.removeItem(KEY);
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
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}
