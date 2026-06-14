/**
 * RoxLive sync + auth Worker — Cloudflare Worker + KV.
 *
 * Stores each crew athlete's workout history AND authenticates them with a real
 * password, so one login (at the Hybrid Crew hub) unlocks cross-device sync.
 *
 *   POST /login     { user, password }                     -> { token, mustChange }
 *   POST /password  { user, currentPassword, newPassword } -> { token }
 *   GET  /history?user=<id>                                 -> { sessions, tombstones }
 *   PUT  /history?user=<id>  { sessions, tombstones }       -> { ok, count }
 *
 * Auth:
 *  - Passwords: PBKDF2-SHA256 + per-user random salt, stored in KV (auth:<user>).
 *    The per-record `iter` is honored on verify so the cost can be raised later.
 *  - First login seeds the password to the athlete's name (the crew's existing
 *    soft credential), flagged mustChange. NOTE: crew names are public, so an
 *    un-changed account is only as private as its name — athletes are nudged to
 *    change it immediately. A coach can reset any account by deleting auth:<user>.
 *  - Sessions: HMAC-SHA256(AUTH_SECRET) over {u, exp, e}. `e` is a per-user epoch
 *    stored in the auth record; /history checks it, so CHANGING THE PASSWORD
 *    REVOKES all older tokens (closes the name-window the moment a real password
 *    is set). ~90-day TTL.
 *  - /history needs a valid token whose user === ?user AND whose epoch matches the
 *    current record — real per-athlete isolation + revocation.
 *  - Browser requests must match ALLOW_ORIGIN.
 *
 * Secrets/bindings (see sync/README.md): KV HISTORY, secret AUTH_SECRET, var ALLOW_ORIGIN.
 */

const USER_RE = /^[a-z0-9-]{1,40}$/;
const CREW = new Set([
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
]);
const PBKDF2_ITER = 100000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MIN_PASSWORD = 6;
const SERVER_MAX = 200;
const TOMB_MAX = 1000;
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
  if (!USER_RE.test(user) || !CREW.has(user)) return json({ error: "unknown user" }, 403, cors);
  if (!password) return json({ error: "password required" }, 400, cors);

  const recRaw = await env.HISTORY.get(`auth:${user}`);
  let rec;
  let mustChange;
  if (!recRaw) {
    // First sign-in: seed with the athlete's name (their existing soft credential).
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
  const token = await makeToken(user, env.AUTH_SECRET, rec.epoch);
  return json({ ok: true, user, token, mustChange }, 200, cors);
}

async function handlePassword(request, env, cors) {
  const body = await readJson(request);
  const user = String((body && body.user) || "").toLowerCase();
  const current = String((body && body.currentPassword) || "");
  const next = String((body && body.newPassword) || "");
  if (!USER_RE.test(user) || !CREW.has(user)) return json({ error: "unknown user" }, 403, cors);
  if (next.length < MIN_PASSWORD) return json({ error: `new password must be at least ${MIN_PASSWORD} characters` }, 400, cors);
  if (next.toLowerCase() === user) return json({ error: "choose a password different from your name" }, 400, cors);

  // Require the account to exist (you must /login first, which seeds it). This
  // removes the unauthenticated "set a password on a never-touched account" path.
  const recRaw = await env.HISTORY.get(`auth:${user}`);
  if (!recRaw) return json({ error: "sign in first" }, 401, cors);
  const rec = JSON.parse(recRaw);
  const got = await hashPassword(current, rec.salt, rec.iter);
  if (!timingSafeEqual(got, rec.hash)) return json({ error: "current password is wrong" }, 401, cors);

  // Fresh salt + epoch → all previously-issued tokens stop verifying.
  const fresh = await newRecord(next, false);
  await env.HISTORY.put(`auth:${user}`, JSON.stringify(fresh));
  const token = await makeToken(user, env.AUTH_SECRET, fresh.epoch);
  return json({ ok: true, token }, 200, cors);
}

/* ---------------------------- history handler ---------------------------- */

async function handleHistory(request, env, cors, url) {
  const user = (url.searchParams.get("user") || "").toLowerCase();
  if (!USER_RE.test(user) || !CREW.has(user)) return json({ error: "unknown user" }, 403, cors);

  const authz = request.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const payload = token ? await verifyToken(token, env.AUTH_SECRET) : null;
  if (!payload || payload.u !== user) return json({ error: "unauthorized" }, 401, cors);

  // Bind the token to the current auth record's epoch (revoked on password change).
  const recRaw = await env.HISTORY.get(`auth:${user}`);
  if (!recRaw) return json({ error: "unauthorized" }, 401, cors);
  let rec;
  try {
    rec = JSON.parse(recRaw);
  } catch {
    return json({ error: "unauthorized" }, 401, cors);
  }
  if (payload.e !== rec.epoch) return json({ error: "session expired — sign in again" }, 401, cors);

  const key = `hist:${user}`;
  if (request.method === "GET") {
    const store = await readStore(env, key);
    return json({ sessions: store.sessions, tombstones: store.tombstones }, 200, cors);
  }
  if (request.method === "PUT") {
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
// Tombstones use a null-prototype map + own-property checks, so a session id that
// collides with a built-in name ("toString", "__proto__", …) is handled correctly.
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
