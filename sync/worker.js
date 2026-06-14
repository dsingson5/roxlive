/**
 * RoxLive history-sync Worker — a tiny Cloudflare Worker backed by KV so an
 * athlete's saved workouts follow them to any device they sign in on.
 *
 * GitHub Pages is static and localStorage is per-device, so cross-device history
 * needs one small shared store. This Worker is that store. It is INDEPENDENT of
 * the Strava worker — deploy it on its own.
 *
 *   GET  /history?user=<id>   -> { sessions: [...], tombstones: {id: ts} }
 *   PUT  /history?user=<id>   body { sessions, tombstones } -> { ok, count }
 *
 * The PUT does a server-side READ-MERGE-WRITE (union by session id), so two
 * devices can push concurrently without clobbering each other — every workout
 * survives. Deletes are conveyed as tombstones (id -> deletedAt) so a union
 * can't resurrect a removed session. The store keeps a generous cap; the client
 * shows fewer, so the cloud never prunes below what any device has held.
 *
 * Access model (matches the Hybrid Crew hub's name-based gate, so sync needs NO
 * per-device setup): a request is allowed when the `user` is a known crew member
 * AND, for browser requests, the Origin matches ALLOW_ORIGIN. There is no shared
 * client secret to ship in the public bundle. An OPTIONAL SYNC_KEY is still
 * honored — if you set that secret AND a client sends a matching Bearer token,
 * fine; clients that send no token are allowed (keyless). Treat the data as
 * crew-visible: this is a convenience store for low-sensitivity workout metrics,
 * gated the same way the hub itself is.
 *
 * Setup (see sync/README.md):
 *   1. Create a KV namespace and bind it as  HISTORY.
 *   2. Optional:  ALLOW_ORIGIN  (defaults to "*"); set it to your site to lock CORS.
 */

const USER_RE = /^[a-z0-9-]{1,40}$/;
// Mirrors hybrid-crew/enter.html + src/lib/user.ts. Only these buckets exist.
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
const SERVER_MAX = 200; // cloud keeps far more than the client shows (50)
const TOMB_MAX = 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB hard cap (measured, not declared)

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (!env.HISTORY) return json({ error: "Worker missing HISTORY KV binding" }, 500, cors);

    // Browser requests must come from the configured site (blocks cross-site use).
    const reqOrigin = request.headers.get("Origin");
    if (reqOrigin && allowOrigin !== "*" && reqOrigin !== allowOrigin) {
      return json({ error: "forbidden origin" }, 403, cors);
    }

    // Optional shared key: only enforced if you've set SYNC_KEY *and* the client
    // sends one. Keyless clients are allowed (the crew allow-list is the gate).
    const authz = request.headers.get("authorization") || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    if (token && env.SYNC_KEY && token !== env.SYNC_KEY) {
      return json({ error: "unauthorized" }, 401, cors);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/history") return json({ error: "not found" }, 404, cors);

    const user = (url.searchParams.get("user") || "").toLowerCase();
    if (!USER_RE.test(user) || !CREW.has(user)) return json({ error: "unknown user" }, 403, cors);
    const key = `hist:${user}`;

    try {
      if (request.method === "GET") {
        const store = await readStore(env, key);
        return json({ sessions: store.sessions, tombstones: store.tombstones }, 200, cors);
      }

      if (request.method === "PUT") {
        // Measure the bytes actually received — never trust Content-Length.
        const buf = await request.arrayBuffer();
        if (buf.byteLength > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413, cors);
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          return json({ error: "invalid JSON body" }, 400, cors);
        }
        const inSessions = Array.isArray(body && body.sessions) ? body.sessions : [];
        const inTomb = isPlainObject(body && body.tombstones) ? body.tombstones : {};

        const existing = await readStore(env, key);
        const tombstones = capTombstones(mergeTombstones(existing.tombstones, inTomb), TOMB_MAX);
        let sessions = unionById(existing.sessions, inSessions);
        sessions = sessions.filter((s) => s && typeof s.id === "string" && !tombstones[s.id]);
        sessions.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
        sessions = sessions.slice(0, SERVER_MAX);

        await env.HISTORY.put(key, JSON.stringify({ sessions, tombstones, updatedAt: Date.now() }));
        return json({ ok: true, count: sessions.length }, 200, cors);
      }

      return json({ error: "method not allowed" }, 405, cors);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 502, cors);
    }
  },
};

async function readStore(env, key) {
  const raw = await env.HISTORY.get(key);
  if (!raw) return { sessions: [], tombstones: {} };
  try {
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return { sessions: obj, tombstones: {} }; // legacy shape
    return {
      sessions: Array.isArray(obj && obj.sessions) ? obj.sessions : [],
      tombstones: isPlainObject(obj && obj.tombstones) ? obj.tombstones : {},
    };
  } catch {
    return { sessions: [], tombstones: {} };
  }
}

/** Union two session lists by id, keeping the richer copy on conflict. */
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
  const out = { ...(a || {}) };
  for (const [id, ts] of Object.entries(b || {})) {
    const n = Number(ts) || 0;
    if (n > (out[id] || 0)) out[id] = n;
  }
  return out;
}

function capTombstones(tomb, max) {
  const entries = Object.entries(tomb);
  if (entries.length <= max) return tomb;
  entries.sort((x, y) => y[1] - x[1]);
  return Object.fromEntries(entries.slice(0, max));
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
