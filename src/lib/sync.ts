/**
 * Cross-device history sync (client side). Optional and local-first: until the
 * athlete fills in a Sync URL + key (Settings → Cross-device sync) every export
 * here is a no-op and RoxLive behaves exactly as before. Once configured, the
 * signed-in athlete's saved workouts are pulled from a tiny Cloudflare Worker on
 * load and pushed after each change, so history follows them to any device.
 *
 * The Worker does a server-side union on write (see sync/worker.js), so devices
 * never clobber each other. We still merge locally on pull to fold in any
 * local-only sessions not yet pushed. Deletes travel as tombstones (id -> ts) so
 * a union can't resurrect a removed workout, and RPE is merged field-by-field so
 * an overall score on one device and per-segment scores on another both survive.
 *
 * Backend contract (see sync/worker.js):
 *   GET  <url>/history?user=<id>  -> { sessions, tombstones }
 *   PUT  <url>/history?user=<id>  body { sessions, tombstones } ; Bearer <key>
 */

import type { RpeLog, SessionSummary } from "../types";

const URL_KEY = "roxlive.sync.url";
const SESSION_KEY = "roxlive.session";
const MAX = 50; // keep in step with lib/history.ts

// Built-in endpoint so there's no per-device URL setup. Auth is a signed session
// token from /login (set by the Hybrid Crew hub login or RoxLive sign-in) — no
// secret ships in this bundle. Power users can override the URL in Settings.
const DEFAULT_SYNC_URL = "https://roxlive-sync.david-singson.workers.dev";

export type Tombstones = Record<string, number>;
export interface RemoteHistory {
  sessions: SessionSummary[];
  tombstones: Tombstones;
}

export interface SyncConfig {
  url: string;
}

export function loadSyncConfig(): SyncConfig {
  try {
    return { url: (localStorage.getItem(URL_KEY) || "").trim() || DEFAULT_SYNC_URL };
  } catch {
    return { url: DEFAULT_SYNC_URL };
  }
}

export function saveSyncConfig(c: SyncConfig): void {
  try {
    localStorage.setItem(URL_KEY, c.url.trim().replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

export function isSyncConfigured(c: SyncConfig = loadSyncConfig()): boolean {
  return !!c.url;
}

/* ------------------------------ session/auth ----------------------------- */

export function loadSession(): string {
  try {
    return localStorage.getItem(SESSION_KEY) || "";
  } catch {
    return "";
  }
}
function saveSession(t: string): void {
  try {
    localStorage.setItem(SESSION_KEY, t);
  } catch {
    /* ignore */
  }
}
export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** The user the current (locally-unexpired) session belongs to, or null. The
 *  server re-verifies the HMAC signature; this only decodes for UI gating. */
export function sessionUser(): string | null {
  const t = loadSession();
  const dot = t.indexOf(".");
  if (dot <= 0) return null;
  try {
    const payload = JSON.parse(decodeB64url(t.slice(0, dot)));
    if (!payload || typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload.u;
  } catch {
    return null;
  }
}

/** Sign in: verifies the password server-side and stores the session token. */
export async function login(user: string, password: string): Promise<{ ok: boolean; mustChange?: boolean; error?: string }> {
  const { url } = loadSyncConfig();
  try {
    const res = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) return { ok: false, error: data.error || `sign-in failed (${res.status})` };
    saveSession(data.token);
    return { ok: true, mustChange: !!data.mustChange };
  } catch {
    return { ok: false, error: "network error — try again" };
  }
}

/** Change password (requires the current one); refreshes the session token. */
export async function changePassword(
  user: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const { url } = loadSyncConfig();
  try {
    const res = await fetch(`${url}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) return { ok: false, error: data.error || `change failed (${res.status})` };
    saveSession(data.token);
    return { ok: true };
  } catch {
    return { ok: false, error: "network error — try again" };
  }
}

/* -------------------------------- sync I/O ------------------------------- */

function endpoint(url: string, user: string): string {
  return `${url}/history?user=${encodeURIComponent(user)}`;
}
function authHeaders(): Record<string, string> {
  const t = loadSession();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/**
 * Pull the athlete's cloud history. Returns null unless signed in as `user`
 * (and on any network/auth error) so callers keep their local copy. Never throws.
 */
export async function pullHistory(user: string | null): Promise<RemoteHistory | null> {
  const c = loadSyncConfig();
  if (!user || !isSyncConfigured(c) || sessionUser() !== user) return null;
  try {
    const res = await fetch(endpoint(c.url, user), { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sessions: Array.isArray(data?.sessions) ? (data.sessions as SessionSummary[]) : [],
      tombstones: isPlainObject(data?.tombstones) ? (data.tombstones as Tombstones) : {},
    };
  } catch {
    return null;
  }
}

async function putHistory(user: string, sessions: SessionSummary[], tombstones: Tombstones): Promise<void> {
  const c = loadSyncConfig();
  if (!isSyncConfigured(c) || sessionUser() !== user) return;
  await fetch(endpoint(c.url, user), {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ sessions: sessions.slice(0, MAX), tombstones }),
    keepalive: true, // let a push begun on unload still complete
  });
}

interface PendingPush {
  timer: ReturnType<typeof setTimeout>;
  sessions: SessionSummary[];
  tombstones: Tombstones;
}
const pending = new Map<string, PendingPush>();

/**
 * Debounced, fire-and-forget push for `user`. Called from lib/history.ts after
 * every local write, so all mutation paths (App + squad) sync without each call
 * site knowing about it. No-op when sync is off.
 */
export function pushHistorySoon(user: string | null, sessions: SessionSummary[], tombstones: Tombstones): void {
  if (!user || !isSyncConfigured() || sessionUser() !== user) return;
  const prev = pending.get(user);
  if (prev) clearTimeout(prev.timer);
  const snapSessions = sessions.slice(0, MAX);
  const snapTomb = { ...tombstones };
  const timer = setTimeout(() => {
    pending.delete(user);
    putHistory(user, snapSessions, snapTomb).catch(() => {
      /* best-effort; local copy is authoritative on this device */
    });
  }, 1200);
  pending.set(user, { timer, sessions: snapSessions, tombstones: snapTomb });
}

/**
 * Flush any debounced pushes immediately — issues the captured payload right now
 * (keepalive). Call on pagehide so a workout saved < debounce before the tab is
 * backgrounded still reaches the cloud instead of being lost with the timer.
 */
export function flushPendingPushes(): void {
  for (const [user, p] of pending) {
    clearTimeout(p.timer);
    putHistory(user, p.sessions, p.tombstones).catch(() => {
      /* best-effort */
    });
  }
  pending.clear();
}

/**
 * Merge two history lists into one for display/local storage: union by session
 * id, drop tombstoned ids, keep the richer copy on conflict (field-merged RPE),
 * newest first, capped. Union biases toward preserving workouts.
 */
export function mergeHistory(a: SessionSummary[], b: SessionSummary[], tombstones: Tombstones = {}): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const s of [...a, ...b]) {
    if (!s || typeof s.id !== "string") continue;
    const cur = byId.get(s.id);
    byId.set(s.id, cur ? richer(cur, s) : s);
  }
  return [...byId.values()]
    .filter((s) => !tombstones[s.id])
    .sort((x, y) => (y.endedAt || 0) - (x.endedAt || 0))
    .slice(0, MAX);
}

/** Union two tombstone maps, keeping the latest deletedAt per id. */
export function mergeTombstones(a: Tombstones = {}, b: Tombstones = {}): Tombstones {
  const out: Tombstones = { ...a };
  for (const [id, ts] of Object.entries(b)) {
    const n = Number(ts) || 0;
    if (n > (out[id] || 0)) out[id] = n;
  }
  return out;
}

function richer(x: SessionSummary, y: SessionSummary): SessionSummary {
  // Non-RPE fields are set at session creation and identical across devices, so
  // the base pick is cosmetic; RPE is the only post-hoc-edited field, merged below.
  const base = (y.endedAt || 0) >= (x.endedAt || 0) ? y : x;
  const rpe = mergeRpe(x.rpe, y.rpe);
  return rpe ? { ...base, rpe } : base;
}

function mergeRpe(a: RpeLog | undefined, b: RpeLog | undefined): RpeLog | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const overall =
    a.overall == null ? b.overall ?? null : b.overall == null ? a.overall : Math.max(a.overall, b.overall);
  const per = mergeSeg(a.perSegment, b.perSegment);
  const out: RpeLog = { overall };
  if (per) out.perSegment = per;
  return out;
}

function mergeSeg(
  a: Record<number, number> | undefined,
  b: Record<number, number> | undefined
): Record<number, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<number, number> = {};
  for (const o of [a || {}, b || {}]) {
    for (const k of Object.keys(o)) {
      const key = Number(k);
      out[key] = out[key] == null ? o[key] : Math.max(out[key], o[key]);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Decode a base64url segment to its (ASCII JSON) string. */
function decodeB64url(s: string): string {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return atob(b);
}
