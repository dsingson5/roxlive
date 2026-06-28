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
 *   Async video coaching (R2 binding REVIEW):
 *   POST /review/upload?movement=&session=&note=  (raw video body) -> { id }
 *   GET  /review/list                              -> { items:[...] }  (own; admin=all)
 *   GET  /review/item?id=<id>                      -> { item }         (owner|admin)
 *   GET  /review/clip?id=<id>                      -> video bytes      (owner|admin)
 *   POST /review/feedback { id, text, annotations } -> { ok }          (admin only)
 *   POST /review/delete   { id }                    -> { ok }          (owner|admin)
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
  "fayth",
  "aura",
  "levelshyroxpt-sample",
  "ommohyroxpc-sample",
];
// Access removed: "marianne", "aleena" (dropped from CREW → login + sync + admin
// read all return 403, revoking any existing session token immediately too).
const CREW_SET = new Set(CREW);
const ADMIN = new Set(["david"]); // coach: may read any athlete's data + manage access

// Coach-managed access control (dynamic; KV "access:v1"). Default = everyone
// enabled with every card on; the store only records EXCEPTIONS, so it applies to
// any crew member present OR added in the future without a code change.
//   { disabled: { [user]: true }, cards: { [user]: { [cardId]: false } } }
const ACCESS_KEY = "access:v1";
// The toggleable feature "cards" a crew member can have. id = stable slug used by
// the hub tiles (data-card) + page guards; label = shown in the coach UI.
const CARDS = [
  { id: "roxlive", label: "RoxLive (live workout app)" },
  { id: "calmer", label: "Calmer / Sleep helper" },
  { id: "strength", label: "Strength A–D" },
  { id: "jakarta", label: "Road to Jakarta (taper plan)" },
  { id: "weights", label: "Crew weights" },
];
const CARD_IDS = new Set(CARDS.map((c) => c.id));

async function loadAccess(env) {
  try {
    const raw = await env.HISTORY.get(ACCESS_KEY);
    if (!raw) return { disabled: {}, cards: {} };
    const o = JSON.parse(raw);
    return {
      disabled: o && typeof o.disabled === "object" && o.disabled ? o.disabled : {},
      cards: o && typeof o.cards === "object" && o.cards ? o.cards : {},
    };
  } catch {
    return { disabled: {}, cards: {} };
  }
}
async function saveAccess(env, cfg) {
  await env.HISTORY.put(ACCESS_KEY, JSON.stringify({ disabled: cfg.disabled || {}, cards: cfg.cards || {} }));
}
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
// Async video coaching (R2-backed review queue)
const REVIEW_PREFIX = "review:"; // KV meta keys: review:<id>
const REVIEW_MAX_BYTES = 1024 * 1024 * 1024; // per-clip cap (1 GB — ample for a 2-min clip)
const REVIEW_PER_OWNER = 30; // keep the newest N clips per athlete
const MOVE_MAX = 40;
const NOTE_MAX = 400;
const FEEDBACK_MAX = 4000;
const MSG_MAX = 1200;   // a single Q&A message
const THREAD_MAX = 60;  // messages kept per clip (oldest dropped beyond this)
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
      if (url.pathname === "/admin/access" && request.method === "GET") return await handleAdminAccessGet(request, env, cors);
      if (url.pathname === "/admin/access" && request.method === "POST") return await handleAdminAccessSet(request, env, cors);
      if (url.pathname === "/me/access" && request.method === "GET") return await handleMeAccess(request, env, cors);
      if (url.pathname === "/history") return await handleHistory(request, env, cors, url);
      if (url.pathname === "/review/upload" && request.method === "POST") return await handleReviewUpload(request, env, cors, url);
      if (url.pathname === "/review/list" && request.method === "GET") return await handleReviewList(request, env, cors);
      if (url.pathname === "/review/item" && request.method === "GET") return await handleReviewItem(request, env, cors, url);
      if (url.pathname === "/review/clip" && request.method === "GET") return await handleReviewClip(request, env, cors, url);
      if (url.pathname === "/review/feedback" && request.method === "POST") return await handleReviewFeedback(request, env, cors);
      if (url.pathname === "/review/message" && request.method === "POST") return await handleReviewMessage(request, env, cors);
      if (url.pathname === "/review/delete" && request.method === "POST") return await handleReviewDelete(request, env, cors);
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
  // Coach can revoke access dynamically — a disabled user can't obtain a token.
  const access = await loadAccess(env);
  if (access.disabled[user]) return json({ error: "Access removed by your coach." }, 403, cors);
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
// Does NOT apply the coach disable — callers that must distinguish "bad/expired
// token" from "disabled user" (e.g. /me/access) use this directly.
async function verifySession(request, env) {
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

// Full auth for DATA endpoints: a coach-revoked user is rejected outright (even
// with a still-valid, un-expired token). Admins are never disabled.
async function authedPayload(request, env) {
  const payload = await verifySession(request, env);
  if (!payload) return null;
  if (!ADMIN.has(payload.u)) {
    const access = await loadAccess(env);
    if (access.disabled[payload.u]) return null;
  }
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

/* ----------------------- access control (coach-only) --------------------- */

// Coach reads the whole roster + each member's disabled flag + disabled cards,
// plus the card catalog, to drive the access UI.
async function handleAdminAccessGet(request, env, cors) {
  const payload = await authedPayload(request, env);
  if (!isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  const cfg = await loadAccess(env);
  const users = CREW.filter((u) => !ADMIN.has(u)).map((u) => ({
    user: u,
    disabled: !!cfg.disabled[u],
    cards: cfg.cards[u] || {}, // only the OFF cards are present (cardId:false)
  }));
  return json({ cards: CARDS, users }, 200, cors);
}

// Coach toggles a user's whole access (op:"setUser") or one card (op:"setCard").
async function handleAdminAccessSet(request, env, cors) {
  const payload = await authedPayload(request, env);
  if (!isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  const body = await readJson(request);
  const op = String((body && body.op) || "");
  const user = String((body && body.user) || "").toLowerCase();
  if (!USER_RE.test(user) || !CREW_SET.has(user)) return json({ error: "unknown user" }, 403, cors);
  if (ADMIN.has(user)) return json({ error: "cannot change the coach's own access" }, 403, cors);

  const cfg = await loadAccess(env);
  if (op === "setUser") {
    if (body.disabled) cfg.disabled[user] = true;
    else delete cfg.disabled[user];
  } else if (op === "setCard") {
    const cardId = String((body && body.cardId) || "");
    if (!CARD_IDS.has(cardId)) return json({ error: "unknown card" }, 400, cors);
    const cards = cfg.cards[user] || {};
    if (body.enabled) delete cards[cardId];
    else cards[cardId] = false;
    if (Object.keys(cards).length) cfg.cards[user] = cards;
    else delete cfg.cards[user];
  } else {
    return json({ error: "unknown op" }, 400, cors);
  }
  await saveAccess(env, cfg);
  await appendActivity(env, user, [{ t: Date.now(), type: "access_change", detail: op }]);
  return json({ ok: true, user, disabled: !!cfg.disabled[user], cards: cfg.cards[user] || {} }, 200, cors);
}

// Any signed-in member reads THEIR OWN effective access so the hub can hide
// disabled cards. (Disabled users 401 here via authedPayload → the guard signs
// them out.)
async function handleMeAccess(request, env, cors) {
  // verifySession (NOT authedPayload) so a disabled user with a valid token gets
  // a 200 with disabled:true — the hub guard caches that and can enforce it even
  // when the worker is later unreachable. A bad/expired token still 401s.
  const payload = await verifySession(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const cfg = await loadAccess(env);
  const disabled = !ADMIN.has(payload.u) && !!cfg.disabled[payload.u];
  return json({ user: payload.u, admin: isAdmin(payload), disabled, cards: cfg.cards[payload.u] || {} }, 200, cors);
}

/* -------------------- async video coaching (review) ---------------------- */
// Athletes upload a movement clip → stored in R2 (binding REVIEW), metadata in
// KV (review:<id>). The coach (admin=david) sees the whole queue and posts
// feedback; everyone else sees only their own clips. Per-user isolation mirrors
// /history: read = owner-or-admin, feedback = admin-only, delete = owner-or-admin.

const reviewMetaKey = (id) => REVIEW_PREFIX + id;
const reviewBlobKey = (id) => "clip/" + id;
function reviewSummary(meta) {
  const thread = Array.isArray(meta.thread) ? meta.thread : [];
  const last = thread.length ? thread[thread.length - 1] : null;
  return {
    owner: meta.owner,
    movement: meta.movement || "",
    session: meta.session || "",
    size: meta.size || 0,
    createdAt: meta.createdAt || 0,
    status: meta.status || "pending",
    hasFeedback: !!meta.feedback,
    feedbackAt: (meta.feedback && meta.feedback.at) || 0,
    threadN: thread.length,
    // who spoke last in the Q&A thread — lets each side badge "needs my reply"
    lastBy: last ? (last.role || "") : "",
    lastAt: last ? last.at : 0,
  };
}

async function handleReviewUpload(request, env, cors, url) {
  if (!env.REVIEW) return json({ error: "review storage not configured (add R2 binding REVIEW)" }, 503, cors);
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const owner = payload.u;
  const len = Number(request.headers.get("content-length") || 0);
  if (len > REVIEW_MAX_BYTES) return json({ error: "clip too large (max 1 GB)" }, 413, cors);
  if (!request.body) return json({ error: "empty body" }, 400, cors);
  const movement = (url.searchParams.get("movement") || "").slice(0, MOVE_MAX);
  const session = (url.searchParams.get("session") || "").slice(0, 16);
  const note = (url.searchParams.get("note") || "").slice(0, NOTE_MAX);
  const ctype = request.headers.get("content-type") || "video/mp4";
  const id = bytesToB64url(crypto.getRandomValues(new Uint8Array(12)));
  // Stream the body straight to R2. R2.put needs a KNOWN length, which the
  // request's Content-Length supplies — so we hand it request.body directly.
  // (Piping through a TransformStream strips the length and makes R2.put throw,
  // which previously surfaced as a bogus "clip too large" for every clip.) The
  // size cap is enforced from Content-Length above; R2 reads only up to the
  // declared length, so a spoofed-small length can't store more than it claims.
  try {
    await env.REVIEW.put(reviewBlobKey(id), request.body, { httpMetadata: { contentType: ctype } });
  } catch (e) {
    await env.REVIEW.delete(reviewBlobKey(id)).catch(() => {});
    return json({ error: "couldn’t store the clip — please retry (" + ((e && e.message) || "upload error") + ")" }, 500, cors);
  }
  const head = await env.REVIEW.head(reviewBlobKey(id));
  const size = head ? head.size : len;
  const meta = { id, owner, movement, session, note, ctype, size, createdAt: Date.now(), status: "pending" };
  await env.HISTORY.put(reviewMetaKey(id), JSON.stringify(meta), { metadata: reviewSummary(meta) });
  await pruneOwnerClips(env, owner);
  await appendActivity(env, owner, [{ t: Date.now(), type: "review_submit", detail: (movement || session || "clip").slice(0, DETAIL_MAX) }]);
  return json({ ok: true, id }, 200, cors);
}

async function listReviewSummaries(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.HISTORY.list({ prefix: REVIEW_PREFIX, cursor });
    for (const k of res.keys) out.push({ id: k.name.slice(REVIEW_PREFIX.length), meta: k.metadata || {} });
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

async function handleReviewList(request, env, cors) {
  if (!env.REVIEW) return json({ error: "review storage not configured" }, 503, cors);
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const admin = isAdmin(payload);
  const all = await listReviewSummaries(env);
  const items = all
    .filter((x) => admin || x.meta.owner === payload.u)
    .map((x) => ({ id: x.id, ...x.meta }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ items }, 200, cors);
}

async function loadReviewMeta(env, id) {
  const raw = await env.HISTORY.get(reviewMetaKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleReviewItem(request, env, cors, url) {
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const id = url.searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400, cors);
  const meta = await loadReviewMeta(env, id);
  if (!meta) return json({ error: "not found" }, 404, cors);
  if (meta.owner !== payload.u && !isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  return json({ item: meta }, 200, cors);
}

async function handleReviewClip(request, env, cors, url) {
  if (!env.REVIEW) return json({ error: "review storage not configured" }, 503, cors);
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const id = url.searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400, cors);
  const meta = await loadReviewMeta(env, id);
  if (!meta) return json({ error: "not found" }, 404, cors);
  if (meta.owner !== payload.u && !isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  const obj = await env.REVIEW.get(reviewBlobKey(id));
  if (!obj) return json({ error: "clip missing" }, 404, cors);
  return new Response(obj.body, {
    headers: { "content-type": meta.ctype || "video/mp4", "content-length": String(meta.size || obj.size || 0), "cache-control": "private, max-age=3600", ...cors },
  });
}

async function handleReviewFeedback(request, env, cors) {
  if (!env.REVIEW) return json({ error: "review storage not configured" }, 503, cors);
  const payload = await authedPayload(request, env);
  if (!isAdmin(payload)) return json({ error: "forbidden" }, 403, cors); // coach only
  const body = await readJson(request);
  const id = String((body && body.id) || "");
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400, cors);
  const meta = await loadReviewMeta(env, id);
  if (!meta) return json({ error: "not found" }, 404, cors);
  const text = typeof body.text === "string" ? body.text.slice(0, FEEDBACK_MAX) : "";
  const annotations = body.annotations != null ? body.annotations : undefined; // opaque JSON (capped by MAX_BODY_BYTES)
  meta.feedback = { text, annotations, by: payload.u, at: Date.now() };
  meta.status = "reviewed";
  await env.HISTORY.put(reviewMetaKey(id), JSON.stringify(meta), { metadata: reviewSummary(meta) });
  await appendActivity(env, meta.owner, [{ t: Date.now(), type: "review_feedback", detail: (meta.movement || "clip").slice(0, DETAIL_MAX) }]);
  return json({ ok: true }, 200, cors);
}

// Q&A thread on a clip: the athlete (owner) asks a follow-up about the form or
// the marked-up video; the coach (admin) replies. Both can post; the other side
// is notified (the coach via the queue badge keyed off lastBy, plus an activity
// note). Returns the updated item so the caller can re-render the thread.
async function handleReviewMessage(request, env, cors) {
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const body = await readJson(request);
  const id = String((body && body.id) || "");
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400, cors);
  const meta = await loadReviewMeta(env, id);
  if (!meta) return json({ error: "not found" }, 404, cors);
  const admin = isAdmin(payload);
  if (meta.owner !== payload.u && !admin) return json({ error: "forbidden" }, 403, cors);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MSG_MAX) : "";
  if (!text) return json({ error: "empty message" }, 400, cors);
  const role = admin ? "coach" : "athlete";
  if (!Array.isArray(meta.thread)) meta.thread = [];
  meta.thread.push({ by: payload.u, role, text, at: Date.now() });
  if (meta.thread.length > THREAD_MAX) meta.thread = meta.thread.slice(-THREAD_MAX);
  await env.HISTORY.put(reviewMetaKey(id), JSON.stringify(meta), { metadata: reviewSummary(meta) });
  if (role === "athlete") {
    for (const a of ADMIN) await appendActivity(env, a, [{ t: Date.now(), type: "review_question", detail: ((meta.owner || "") + " · " + (meta.movement || "clip")).slice(0, DETAIL_MAX) }]);
  } else {
    await appendActivity(env, meta.owner, [{ t: Date.now(), type: "review_reply", detail: (meta.movement || "clip").slice(0, DETAIL_MAX) }]);
  }
  return json({ ok: true, item: meta }, 200, cors);
}

async function handleReviewDelete(request, env, cors) {
  if (!env.REVIEW) return json({ error: "review storage not configured" }, 503, cors);
  const payload = await authedPayload(request, env);
  if (!payload) return json({ error: "unauthorized" }, 401, cors);
  const body = await readJson(request);
  const id = String((body && body.id) || "");
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400, cors);
  const meta = await loadReviewMeta(env, id);
  if (!meta) return json({ ok: true }, 200, cors); // already gone
  if (meta.owner !== payload.u && !isAdmin(payload)) return json({ error: "forbidden" }, 403, cors);
  await env.REVIEW.delete(reviewBlobKey(id));
  await env.HISTORY.delete(reviewMetaKey(id));
  return json({ ok: true }, 200, cors);
}

// Keep only the newest REVIEW_PER_OWNER clips for an athlete (R2 + KV).
async function pruneOwnerClips(env, owner) {
  try {
    const mine = (await listReviewSummaries(env))
      .filter((x) => x.meta.owner === owner)
      .map((x) => ({ id: x.id, createdAt: x.meta.createdAt || 0 }));
    if (mine.length <= REVIEW_PER_OWNER) return;
    mine.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // oldest first
    for (const d of mine.slice(0, mine.length - REVIEW_PER_OWNER)) {
      await env.REVIEW.delete(reviewBlobKey(d.id));
      await env.HISTORY.delete(reviewMetaKey(d.id));
    }
  } catch {
    /* best-effort */
  }
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
  // Post-hoc fields that one device may have and the other not — keep whichever
  // copy carries them so a stale push can't drop the AI coach note / feel / RPE.
  const coachNote = base.coachNote || x.coachNote || y.coachNote;
  const feel = base.feel || x.feel || y.feel;
  const out = { ...base };
  if (rpe) out.rpe = rpe;
  if (coachNote) out.coachNote = coachNote;
  if (feel) out.feel = feel;
  return out;
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
