/**
 * RoxLive sync + auth + coach-admin Worker — Cloudflare Worker + KV.
 *
 * Stores each crew athlete's workout history, authenticates them with a real
 * password (one hub login unlocks sync), logs app activity, and gives the COACH
 * (admin) a read-only view across the crew.
 *
 *   POST /login     { user, password }                     -> { token, mustChange }
 *   POST /password  { user, currentPassword, newPassword } -> { token }
 *   POST /activity  { events:[{type,detail}] }             -> { ok }   (own log)
 *   GET  /history?user=<id>                                 -> { sessions, tombstones }
 *   PUT  /history?user=<id>  { sessions, tombstones }       -> { ok, count }   (own only)
 *   GET  /admin/roster                                      -> { roster:[...] } (admin)
 *   GET  /admin/activity?user=<id>                          -> { events:[...] } (admin)
 *
 * Auth: PBKDF2-SHA256(+salt) password hashes in KV (auth:<user>); first login
 * seeds password=name (mustChange). HMAC sessions {u,exp,e}; the per-user epoch
 * `e` is checked against the auth record, so a password change revokes old tokens.
 * /history & /activity require a valid session for the token's own user; the
 * ADMIN user (david) may additionally READ any athlete's history + activity.
 * Writes are always own-only. Browser requests must match ALLOW_ORIGIN.
 *
 * Activity is meaningful app events (login, feature opened, workout start/done) —
 * not raw input. Athletes should know their coach can see it.
 *
 * Secrets/bindings: KV HISTORY, secret AUTH_SECRET, var ALLOW_ORIGIN.
 */

const USER_RE = /^[a-z0-9-]{1,40}$/;
const CREW = [
  "david",
  "carla",
  "erika",
  "liz",
  "marianne",
  "aleena",
  "fayth",
  "aura",
  "levelshyroxpt-sample",
  "ommohyroxpc-sample",
];
const CREW_SET = new Set(CREW);
const ADMIN = new Set(["david"]); // coach: may read any athlete's data
const PBKDF2_ITER = 100000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 6;
const SERVER_MAX = 200;
const TOMB_MAX = 1000;
const ACTIVITY_MAX = 300; // events kept per user
const ACTIVITY_PER_REQ = 50;
const TYPE_MAX = 40;
const DETAIL_MAX = 160;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.HISTORY) return json({ error: "Worker missing HISTORY KV binding" }, 500, cors);
    if (!env.AUTH_SECRET) return json({ error: "Worker missing AUTH_SECRET secret" }, 500, cors);

    const reqOrigin = request.headers.get("Origin");
    if (reqOrigin && allowOrigin !== "*" && reqOrigin !== allowOrigin) {
      return json({ error: "forbidden origin" }, 403, cors);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/login" && request.method === "POST") return await handleLogin(request, env, cors);
      if (url.pathname === "/password" && request.method === "POST") return await handlePassword(request, env, cors);
      if (url.pathname === "/activity" && request.method === "POST") return await handleActivity(request, env, cors);
      if (url.pathname === "/admin/roster" && request.method === "GET") return await handleAdminRoster(request, env, cors);
      if (url.pathname === "/admin/activity" && request.method === "GET") return await handleAdminActivity(request, env, cors, url);
      if (url.pathname === "/history") return await handleHistory(request, env, cors, url);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      if (e && e.tooLarge) return json({ error: "payload too large" }, 413, cors);
      if (e && e.badJson) return json({ error: "invalid JSON body" }, 400, cors);
      return json({ error: String(e && e.message ? e.message : e) }, 502, cors);
    }
  },
};

/* ----------------------------- auth handlers ----------------------------- */

async function handleLogin(request, env, cors) {
  const body = await readJson(request);
  const user = String((body && body.user) || "").toLowerCase();
  const password = String((body && body.password) || "");
  if (!USER_RE.test(user) || !CREW_SET.has(user)) return json({ error: "unknown user" }, 403, cors);
  if (!password) return json({ error: "password required" }, 400, cors);

  const recRaw = await env.HISTORY.get(`auth:${user}`);
  let rec;
  let mustChange;
  if (!recRaw) {
    if (password !== user) return json({ error: "first sign-in: use your name as the password" }, 401, cors);
    rec = await newRecord(password, true);
    await env.HISTORY.put(`auth:${user}`, JSON.stringify(rec));
    mustChange = true;
  } else {
    rec = JSON.parse(recRaw);
    const got = await hashPassword(password, rec.salt, rec.iter);
    if (!timingSafeEqual(got, rec.hash)) return json({ error: "wrong password" }, 401, cors);
    mustChange = !!rec.mustChange;
  }
  await appendActivity(env, user, [{ t: Date.now(), type: "login" }]);
  const token = await makeToken(user, env.AUTH_SECRET, rec.epoch);
  return json({ ok: true, user, token, mustChange }, 200, cors);
}

async function handlePassword(request, env, cors) {
  const body = await readJson(request);
  const user = String((body && body.user) || "").toLowerCase();
  const current = String((body && body.currentPassword) || "");
  const next = String((body && body.newPassword) || "");
  if (!USER_RE.test(user) || !CREW_SET.has(user)) return json({ error: "unknown user" }, 403, cors);
  if (next.length < MIN_PASSWORD) return json({ error: `new password must be at least ${MIN_PASSWORD} characters` }, 400, cors);
  if (next.toLowerCase() === user) return json({ error: "choose a password different from your name" }, 400, cors);

  const recRaw = await env.HISTORY.get(`auth:${user}`);
  if (!recRaw) return json({ error: "sign in first" }, 401, cors);
  const rec = JSON.parse(recRaw);
  const got = await hashPassword(current, rec.salt, rec.iter);
  if (!timingSafeEqual(got, rec.hash)) return json({ error: "current password is wrong" }, 401, cors);

  const fresh = await newRecord(next, false);
  await env.HISTORY.put(`auth:${user}`, JSON.stringify(fresh));
  await appendActivity(env, user, [{ t: Date.now(), type: "password_change" }]);
  const token = await makeToken(user, env.AUTH_SECRET, fresh.epoch);
  return json({ ok: true, token }, 200, cors);
}

/* ------------------------- session verification -------------------------- */

// Verify the bearer token AND that its epoch still matches the token-holder's
// auth record (so a password change revokes it). Returns the payload or null.
async function authedPayload(request, env) {
  const authz = request.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const payload = token ? await verifyToken(token, env.AUTH_SECRET) : null;
  if (!payload) return null;
  const recRaw = await env.HISTORY.get(`auth:${payload.u}`);
  if (!recRaw) return null;
  let rec;
  try {
    rec = JSON.parse(recRaw);
  } catch {
    return null;
  }
  if (payload.e !== rec.epoch) return null;
  return payload;
}
const isAdmin = (payload) => !!payload && ADMIN.has(payload.u);

/* ---------------------------- history handler ---------------------------- */

async function handleHistory(request, env, cors, url) {
  const user = (url.searchParams.get("user") || "").toLowerCase();
  if (!USER_RE.test(user) || !CREW_SET.has(user)) return json({ error: "unknown user" }, 403, cors);

  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const own = payload.u === user;
  if (!own && !isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);

  const key = `hist:${user}`;
  if (request.method === "GET") {
    const store = await readStore(env, key);
    return json({ sessions: store.sessions, tombstones: store.tombstones }, 200, cors);
  }
  if (request.method === "PUT") {
    if (!own) return json({ error: "forbidden" }, 403, cors); // writes are own-only (even admin)
    const body = await readJson(request);
    const inSessions = Array.isArray(body && body.sessions) ? body.sessions : [];
    const inTomb = isPlainObject(body && body.tombstones) ? body.tombstones : {};
    const existing = await readStore(env, key);
    const tombstones = capTombstones(mergeTombstones(existing.tombstones, inTomb), TOMB_MAX);
    let sessions = unionById(existing.sessions, inSessions);
    sessions = sessions.filter((s) => s && typeof s.id === "string" && !hasOwn(tombstones, s.id));
    sessions.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    sessions = sessions.slice(0, SERVER_MAX);
    await env.HISTORY.put(key, JSON.stringify({ sessions, tombstones, updatedAt: Date.now() }));
    return json({ ok: true, count: sessions.length }, 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

/* ------------------------------- activity -------------------------------- */

async function handleActivity(request, env, cors) {
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const body = await readJson(request);
  const inEvents = Array.isArray(body && body.events) ? body.events.slice(0, ACTIVITY_PER_REQ) : [];
  const now = Date.now();
  const clean = [];
  for (const e of inEvents) {
    if (!e || typeof e.type !== "string") continue;
    const type = e.type.trim().slice(0, TYPE_MAX);
    if (!type) continue; // skip empty/whitespace types
    const ev = { t: now, type };
    if (typeof e.detail === "string" && e.detail.trim()) ev.detail = e.detail.trim().slice(0, DETAIL_MAX);
    clean.push(ev);
  }
  if (clean.length) await appendActivity(env, payload.u, clean); // always the token-holder's own log
  return json({ ok: true }, 200, cors);
}

async function readActivity(env, user) {
  const raw = await env.HISTORY.get(`activity:${user}`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function appendActivity(env, user, events) {
  try {
    const list = await readActivity(env, user);
    for (const e of events) list.push(e);
    const capped = list.slice(-ACTIVITY_MAX);
    await env.HISTORY.put(`activity:${user}`, JSON.stringify(capped));
  } catch {
    /* activity logging is best-effort; never fail the request on it */
  }
}

/* -------------------------------- admin ---------------------------------- */

async function handleAdminRoster(request, env, cors) {
  const payload = await authedPayload(request, env);
  if (!isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  const roster = [];
  for (const user of CREW) {
    const [authRaw, hist, activity] = await Promise.all([
      env.HISTORY.get(`auth:${user}`),
      readStore(env, `hist:${user}`),
      readActivity(env, user),
    ]);
    let enrolled = false;
    let mustChange = false;
    if (authRaw) {
      enrolled = true;
      try {
        mustChange = !!JSON.parse(authRaw).mustChange;
      } catch {
        /* ignore */
      }
    }
    let lastLogin = 0;
    let loginCount = 0;
    for (const e of activity) {
      if (e && e.type === "login") {
        loginCount++;
        if ((e.t || 0) > lastLogin) lastLogin = e.t || 0;
      }
    }
    const lastActive = activity.length ? activity[activity.length - 1].t || 0 : 0;
    let lastWorkout = 0;
    for (const s of hist.sessions) if ((s.endedAt || 0) > lastWorkout) lastWorkout = s.endedAt || 0;
    roster.push({
      user,
      enrolled,
      mustChange,
      lastLogin,
      loginCount,
      lastActive,
      eventCount: activity.length,
      workoutCount: hist.sessions.length,
      lastWorkout,
    });
  }
  return json({ roster }, 200, cors);
}

async function handleAdminActivity(request, env, cors, url) {
  const payload = await authedPayload(request, env);
  if (!isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  const user = (url.searchParams.get("user") || "").toLowerCase();
  if (!USER_RE.test(user) || !CREW_SET.has(user)) return json({ error: "unknown user" }, 403, cors);
  const events = await readActivity(env, user);
  return json({ events: events.slice().reverse() }, 200, cors); // newest first
}

/* ------------------------------- crypto ---------------------------------- */

async function newRecord(password, mustChange) {
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt, PBKDF2_ITER);
  const epoch = bytesToB64url(crypto.getRandomValues(new Uint8Array(8)));
  return { v: 1, salt, hash, iter: PBKDF2_ITER, mustChange, epoch };
}
async function hashPassword(password, saltB64, iter) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: iter || PBKDF2_ITER, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}
async function hmac(payloadB64, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return bytesToB64url(new Uint8Array(sig));
}
async function makeToken(user, secret, epoch) {
  const payloadB64 = bytesToB64url(new TextEncoder().encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS, e: epoch })));
  return `${payloadB64}.${await hmac(payloadB64, secret)}`;
}
async function verifyToken(token, secret) {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmac(payloadB64, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------- helpers --------------------------------- */

async function readJson(request) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw { tooLarge: true };
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw { badJson: true };
  }
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function readStore(env, key) {
  const raw = await env.HISTORY.get(key);
  if (!raw) return { sessions: [], tombstones: nullObj() };
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return { sessions: obj, tombstones: nullObj() };
    return {
      sessions: Array.isArray(obj && obj.sessions) ? obj.sessions : [],
      tombstones: toNullObj(isPlainObject(obj && obj.tombstones) ? obj.tombstones : {}),
    };
  } catch {
    return { sessions: [], tombstones: nullObj() };
  }
}
function unionById(a, b) {
  const byId = new Map();
  for (const s of [...a, ...b]) {
    if (!s || typeof s.id !== "string") continue;
    const cur = byId.get(s.id);
    byId.set(s.id, cur ? richer(cur, s) : s);
  }
  return [...byId.values()];
}
function richer(x, y) {
  const base = (y.endedAt || 0) >= (x.endedAt || 0) ? y : x;
  const rpe = mergeRpe(x.rpe, y.rpe);
  return rpe ? { ...base, rpe } : base;
}
function mergeRpe(a, b) {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const overall =
    a.overall == null ? (b.overall == null ? null : b.overall) : b.overall == null ? a.overall : Math.max(a.overall, b.overall);
  const per = mergeSeg(a.perSegment, b.perSegment);
  const out = { overall };
  if (per) out.perSegment = per;
  return out;
}
function mergeSeg(a, b) {
  if (!a && !b) return undefined;
  const out = {};
  for (const o of [a || {}, b || {}]) for (const k of Object.keys(o)) out[k] = out[k] == null ? o[k] : Math.max(out[k], o[k]);
  return out;
}
function mergeTombstones(a, b) {
  const out = nullObj();
  for (const src of [a || {}, b || {}]) {
    for (const id of Object.keys(src)) {
      const n = Number(src[id]) || 0;
      if (n > (out[id] || 0)) out[id] = n;
    }
  }
  return out;
}
function capTombstones(tomb, max) {
  const entries = Object.keys(tomb).map((k) => [k, tomb[k]]);
  if (entries.length <= max) return tomb;
  entries.sort((x, y) => y[1] - x[1]);
  const out = nullObj();
  for (const [k, v] of entries.slice(0, max)) out[k] = v;
  return out;
}
function nullObj() {
  return Object.create(null);
}
function toNullObj(o) {
  const out = nullObj();
  for (const k of Object.keys(o)) out[k] = o[k];
  return out;
}
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...cors } });
}
