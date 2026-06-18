/**
 * Cross-session strength-set history (Stage 5).
 *
 * Every completed FormLab strength set (a SetReport) is appended to IndexedDB so
 * the athlete can see their per-exercise trend across sessions — clean-rep %,
 * bar-speed loss and tempo over time. IndexedDB (rather than localStorage,
 * which the cardio history uses) because these analysis records accrue with no
 * useful cap and the store is append-mostly.
 *
 * Scoped to the signed-in Hybrid Crew athlete (lib/user.ts): each record stores
 * its `user` and reads filter to the current athlete, so one crew member never
 * sees another's sets on a shared device/origin (see per-user-scoping memory).
 * All operations are best-effort — IndexedDB can be unavailable (private mode,
 * blocked storage) and a coaching aid must never throw into the UI.
 */

import type { SetReport } from "./repForm";
import { resolveCrewUser } from "./user";

const DB_NAME = "roxlive-strength";
const DB_VERSION = 1;
const STORE = "sets";

export interface StrengthSet {
  id: string; // `${ts}-${rand}`
  user: string; // crew id, or "anon"
  exerciseId: string;
  exerciseName: string;
  ts: number; // epoch ms
  reps: number;
  cleanReps: number;
  avgTempo: [number, number, number] | null;
  velLossPct: number | null;
  velLossThreshold: number | null;
  faultCodes: string[]; // distinct fault codes seen in the set (compact)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("byUser", "user", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const userKey = (): string => resolveCrewUser() ?? "anon";

/** Append one completed set. Best-effort: storage errors are swallowed. */
export async function addStrengthSet(r: SetReport | null): Promise<void> {
  if (!r || r.reps <= 0) return;
  const rec: StrengthSet = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user: userKey(),
    exerciseId: r.exerciseId,
    exerciseName: r.exerciseName,
    ts: Date.now(),
    reps: r.reps,
    cleanReps: r.cleanReps,
    avgTempo: r.avgTempo,
    velLossPct: r.velLossPct,
    velLossThreshold: r.velLossThreshold,
    faultCodes: Array.from(new Set(r.faults.map((f) => f.code))),
  };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable — drop silently */
  }
}

/** All sets for the current athlete (newest first), optionally one exercise. */
export async function loadStrengthSets(exerciseId?: string): Promise<StrengthSet[]> {
  const user = userKey();
  try {
    const db = await openDb();
    const all = await new Promise<StrengthSet[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).index("byUser").getAll(IDBKeyRange.only(user));
      req.onsuccess = () => resolve((req.result as StrengthSet[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const filtered = exerciseId ? all.filter((s) => s.exerciseId === exerciseId) : all;
    return filtered.sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Remove one set by id. Best-effort. */
export async function deleteStrengthSet(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export interface StrengthTrend {
  sessions: number;
  lastReps: number | null;
  bestReps: number | null;
  /** mean clean-rep ratio across sets, 0..100 */
  avgCleanPct: number | null;
  /** velocity-loss of the most recent set that tracked it, % */
  lastVelLossPct: number | null;
}

/**
 * Compact roll-up of a set list (already newest-first) for the trend strip.
 * Pure — the self-test below pins its arithmetic.
 */
export function summarizeTrend(sets: StrengthSet[]): StrengthTrend {
  if (!sets.length) return { sessions: 0, lastReps: null, bestReps: null, avgCleanPct: null, lastVelLossPct: null };
  const cleanPcts = sets.map((s) => (s.reps > 0 ? (s.cleanReps / s.reps) * 100 : 0));
  const avgClean = cleanPcts.reduce((a, b) => a + b, 0) / cleanPcts.length;
  const withVel = sets.find((s) => s.velLossPct != null); // newest-first → most recent tracked
  return {
    sessions: sets.length,
    lastReps: sets[0].reps,
    bestReps: Math.max(...sets.map((s) => s.reps)),
    avgCleanPct: Math.round(avgClean),
    lastVelLossPct: withVel ? withVel.velLossPct : null,
  };
}

/** Dev self-test — pins the pure trend arithmetic (no IndexedDB needed). */
export function selfTestStrengthHistory(): { ok: boolean; detail: string } {
  const mk = (over: Partial<StrengthSet>): StrengthSet => ({
    id: "x", user: "anon", exerciseId: "back_squat", exerciseName: "Back Squat", ts: 0,
    reps: 5, cleanReps: 5, avgTempo: null, velLossPct: null, velLossThreshold: null, faultCodes: [],
    ...over,
  });
  const sets = [
    mk({ ts: 3, reps: 5, cleanReps: 3, velLossPct: 22 }), // newest
    mk({ ts: 2, reps: 8, cleanReps: 8, velLossPct: null }),
    mk({ ts: 1, reps: 6, cleanReps: 3, velLossPct: 10 }),
  ];
  const t = summarizeTrend(sets);
  // clean%: (60 + 100 + 50)/3 = 70 ; best reps 8 ; last 5 ; last tracked velLoss = newest with a value = 22
  const ok = t.sessions === 3 && t.lastReps === 5 && t.bestReps === 8 && t.avgCleanPct === 70 && t.lastVelLossPct === 22 && summarizeTrend([]).sessions === 0;
  return { ok, detail: `sessions=${t.sessions} lastReps=${t.lastReps} bestReps=${t.bestReps} avgClean=${t.avgCleanPct}% lastVelLoss=${t.lastVelLossPct}` };
}
