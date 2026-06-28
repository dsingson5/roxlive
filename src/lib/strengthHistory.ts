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

export type LoadUnit = "kg" | "lb";

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
  /** Weight lifted, in `loadUnit`. null = bodyweight / not recorded. Added after
   *  the store shipped, so historical records may lack it — readers treat the
   *  absence as null (no schema bump needed: no new index). */
  load?: number | null;
  loadUnit?: LoadUnit;
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

/**
 * Append one completed set. Best-effort: storage errors are swallowed.
 * `load` is the weight the athlete entered for this set (in `load.unit`); a null
 * or non-positive value is stored as bodyweight (load: null).
 */
export async function addStrengthSet(
  r: SetReport | null,
  load?: { value: number | null; unit: LoadUnit }
): Promise<void> {
  if (!r || r.reps <= 0) return;
  const v = load?.value;
  const cleanLoad = v != null && Number.isFinite(v) && v > 0 ? v : null;
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
    load: cleanLoad,
    loadUnit: load?.unit ?? "kg",
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

/**
 * Reduce a newest-first set list to the most-recent set per exercise id.
 * Pure (no IndexedDB) so the self-test can pin it. First hit wins → newest.
 */
export function pickLastByExercise(sets: StrengthSet[]): Record<string, StrengthSet> {
  const out: Record<string, StrengthSet> = {};
  for (const s of sets) if (!(s.exerciseId in out)) out[s.exerciseId] = s;
  return out;
}

/** The current athlete's most-recent set per exercise (exerciseId → newest set). */
export async function loadLastByExercise(): Promise<Record<string, StrengthSet>> {
  return pickLastByExercise(await loadStrengthSets());
}

/** "80 kg", "82.5 kg", or "BW" when no load was recorded (bodyweight). */
export function fmtLoad(load: number | null | undefined, unit: LoadUnit | undefined): string {
  if (load == null || !Number.isFinite(load)) return "BW";
  const n = Math.round(load * 10) / 10; // round BEFORE the zero check, so a sub-0.05 load reads "BW", not "0 kg"
  if (n <= 0) return "BW";
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)} ${unit ?? "kg"}`;
}

/**
 * Friendly "when" for a past set: today / yesterday / Nd ago for the last week,
 * else an absolute "Mon D" (with the year when it differs from now). `now` is
 * passed in for testability and so the value is stable within a render.
 */
export function relativeWhen(ts: number, now: number): string {
  const d0 = new Date(ts); d0.setHours(0, 0, 0, 0);
  const n0 = new Date(now); n0.setHours(0, 0, 0, 0);
  const days = Math.round((n0.getTime() - d0.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date(now).getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
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
  /** load of the most recent set (null = bodyweight / not recorded) */
  lastLoad: number | null;
  /** unit the most recent set's load was entered in */
  lastLoadUnit: LoadUnit;
}

/**
 * Compact roll-up of a set list (already newest-first) for the trend strip.
 * Pure — the self-test below pins its arithmetic.
 */
export function summarizeTrend(sets: StrengthSet[]): StrengthTrend {
  if (!sets.length)
    return { sessions: 0, lastReps: null, bestReps: null, avgCleanPct: null, lastVelLossPct: null, lastLoad: null, lastLoadUnit: "kg" };
  const cleanPcts = sets.map((s) => (s.reps > 0 ? (s.cleanReps / s.reps) * 100 : 0));
  const avgClean = cleanPcts.reduce((a, b) => a + b, 0) / cleanPcts.length;
  const withVel = sets.find((s) => s.velLossPct != null); // newest-first → most recent tracked
  const newest = sets[0];
  return {
    sessions: sets.length,
    lastReps: newest.reps,
    bestReps: Math.max(...sets.map((s) => s.reps)),
    avgCleanPct: Math.round(avgClean),
    lastVelLossPct: withVel ? withVel.velLossPct : null,
    lastLoad: newest.load ?? null,
    lastLoadUnit: newest.loadUnit ?? "kg",
  };
}

/** Dev self-test — pins the pure trend arithmetic (no IndexedDB needed). */
export function selfTestStrengthHistory(): { ok: boolean; detail: string } {
  const mk = (over: Partial<StrengthSet>): StrengthSet => ({
    id: "x", user: "anon", exerciseId: "back_squat", exerciseName: "Back Squat", ts: 0,
    reps: 5, cleanReps: 5, avgTempo: null, velLossPct: null, velLossThreshold: null, faultCodes: [],
    load: null, loadUnit: "kg",
    ...over,
  });
  const sets = [
    mk({ ts: 3, reps: 5, cleanReps: 3, velLossPct: 22, load: 82.5, loadUnit: "kg" }), // newest
    mk({ ts: 2, reps: 8, cleanReps: 8, velLossPct: null, load: 80, loadUnit: "kg" }),
    mk({ ts: 1, reps: 6, cleanReps: 3, velLossPct: 10 }),
  ];
  const t = summarizeTrend(sets);
  // clean%: (60 + 100 + 50)/3 = 70 ; best reps 8 ; last 5 ; last tracked velLoss = newest with a value = 22 ; last load = newest = 82.5
  const trendOk = t.sessions === 3 && t.lastReps === 5 && t.bestReps === 8 && t.avgCleanPct === 70 && t.lastVelLossPct === 22 && t.lastLoad === 82.5 && summarizeTrend([]).sessions === 0;

  // last-by-exercise picks the newest set per id; formatters render load + "when".
  const multi = [
    mk({ id: "a", ts: 3, exerciseId: "bench_press", exerciseName: "Bench", load: 60 }), // newest bench
    mk({ id: "b", ts: 2, exerciseId: "bench_press", exerciseName: "Bench", load: 55 }),
    mk({ id: "c", ts: 1, exerciseId: "back_squat", load: 100 }),
  ];
  const byEx = pickLastByExercise(multi);
  const pickOk = byEx.bench_press?.id === "a" && byEx.back_squat?.id === "c" && Object.keys(byEx).length === 2;
  const fmtOk = fmtLoad(80, "kg") === "80 kg" && fmtLoad(82.5, "kg") === "82.5 kg" && fmtLoad(null, "kg") === "BW" && fmtLoad(0, "lb") === "BW" && fmtLoad(0.04, "kg") === "BW";
  const whenOk = relativeWhen(0, 0) === "today";

  const ok = trendOk && pickOk && fmtOk && whenOk;
  return { ok, detail: `trend=${trendOk} pick=${pickOk} fmt=${fmtOk} when=${whenOk} · lastLoad=${t.lastLoad}${t.lastLoadUnit}` };
}
