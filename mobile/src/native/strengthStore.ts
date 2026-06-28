/**
 * Native persistence (AsyncStorage) — the RN replacement for the web app's
 * IndexedDB strength history (lib/strengthHistory.ts) + localStorage session
 * (lib/strengthSession.ts). Same function signatures as the web side so the
 * ported session runner can call these instead, and it REUSES the web's pure
 * helpers + types (pickLastByExercise, StrengthSet) so the data shape can't drift.
 *
 * Records are stored as a single JSON array per athlete (no indexed query) —
 * fine for the volume a strength log accrues; filtering/sorting is in-memory.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StrengthSession } from "@engine/strengthSession";
import { pickLastByExercise, type StrengthSet, type LoadUnit } from "@engine/strengthHistory";
import type { SetReport } from "@engine/repForm";
import { getCrewUser } from "./identity";

const SESSION_KEY = "roxlive.strength.session.v1";
const HISTORY_KEY = "roxlive.strength.history.v1";
const scoped = async (base: string): Promise<string> => `${base}:${await getCrewUser()}`;

/* ---------------- current session ---------------- */

export async function saveSession(session: StrengthSession | null): Promise<void> {
  try {
    const key = await scoped(SESSION_KEY);
    if (session) await AsyncStorage.setItem(key, JSON.stringify(session));
    else await AsyncStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export async function loadSession(): Promise<StrengthSession | null> {
  try {
    const raw = await AsyncStorage.getItem(await scoped(SESSION_KEY));
    if (raw) {
      const s = JSON.parse(raw) as StrengthSession;
      if (s && Array.isArray(s.blocks)) return s;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/* ---------------- set history ---------------- */

async function loadAll(key: string): Promise<StrengthSet[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StrengthSet[]) : [];
  } catch {
    return [];
  }
}

/** Append one completed set. Mirrors lib/strengthHistory.ts's addStrengthSet. */
export async function addStrengthSet(r: SetReport | null, load?: { value: number | null; unit: LoadUnit }): Promise<void> {
  if (!r || r.reps <= 0) return;
  const v = load?.value;
  const rec: StrengthSet = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user: await getCrewUser(),
    exerciseId: r.exerciseId,
    exerciseName: r.exerciseName,
    ts: Date.now(),
    reps: r.reps,
    cleanReps: r.cleanReps,
    avgTempo: r.avgTempo,
    velLossPct: r.velLossPct,
    velLossThreshold: r.velLossThreshold,
    faultCodes: Array.from(new Set(r.faults.map((f) => f.code))),
    load: v != null && Number.isFinite(v) && v > 0 ? v : null,
    loadUnit: load?.unit ?? "kg",
  };
  try {
    const key = await scoped(HISTORY_KEY);
    const all = await loadAll(key);
    all.push(rec);
    await AsyncStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** All sets for the athlete (newest first), optionally one exercise. */
export async function loadStrengthSets(exerciseId?: string): Promise<StrengthSet[]> {
  const all = await loadAll(await scoped(HISTORY_KEY));
  const filtered = exerciseId ? all.filter((s) => s.exerciseId === exerciseId) : all;
  return filtered.sort((a, b) => b.ts - a.ts);
}

/** Most-recent set per exercise (reuses the web's pure reducer). */
export async function loadLastByExercise(): Promise<Record<string, StrengthSet>> {
  return pickLastByExercise(await loadStrengthSets());
}
