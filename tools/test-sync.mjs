// Verifies sync/worker.js: server-side union (no clobber), tombstone deletes,
// body guard, cap, auth, RPE field-merge. Run: node tools/test-sync.mjs
import worker from "../sync/worker.js";

const kv = new Map();
const env = {
  SYNC_KEY: "secret",
  ALLOW_ORIGIN: "*",
  HISTORY: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => void kv.set(k, v),
  },
};
const U = "https://w/history?user=david";
const auth = { authorization: "Bearer secret", "content-type": "application/json" };

const mk = (id, ended, rpe) => ({ id, endedAt: ended, durationSec: 1, mode: "workout", ...(rpe ? { rpe } : {}) });
const call = (method, body, headers = auth, url = U) =>
  worker.fetch(new Request(url, { method, headers, body: body == null ? undefined : body }), env);
const put = (obj) => call("PUT", JSON.stringify(obj));
const get = async () => (await (await call("GET")).json()).sessions;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };

// A. auth required
ok("no token -> 401", (await call("GET", null, { "content-type": "application/json" })).status === 401);
ok("bad user -> 400", (await call("GET", null, auth, "https://w/history?user=Bad_User")).status === 400);

// B. basic round-trip
await put({ sessions: [mk("s1", 100), mk("s2", 200)], tombstones: {} });
let g = await get();
ok("round-trip 2", g.length === 2 && g[0].id === "s2" && g[1].id === "s1"); // sorted desc

// C. CONCURRENT push from a device that only knows s3 must NOT clobber s1/s2
await put({ sessions: [mk("s3", 300)], tombstones: {} });
g = await get();
ok("no-clobber union (s1,s2,s3 all present)", g.map((s) => s.id).sort().join() === "s1,s2,s3");

// D. delete s1 via tombstone; a later stale push that still carries s1 must NOT resurrect it
await put({ sessions: [mk("s2", 200), mk("s3", 300)], tombstones: { s1: 1000 } });
g = await get();
ok("delete via tombstone", !g.some((s) => s.id === "s1"));
await put({ sessions: [mk("s1", 100), mk("s3", 300)], tombstones: {} }); // stale device re-pushes s1
g = await get();
ok("tombstone blocks resurrection", !g.some((s) => s.id === "s1"));

// E. RPE field-merge: overall on one push, per-segment on another
await put({ sessions: [mk("r1", 400, { overall: 8 })], tombstones: {} });
await put({ sessions: [mk("r1", 400, { overall: null, perSegment: { 0: 7 } })], tombstones: {} });
g = await get();
const r1 = g.find((s) => s.id === "r1");
ok("rpe overall survives", r1 && r1.rpe.overall === 8);
ok("rpe perSegment survives", r1 && r1.rpe.perSegment && r1.rpe.perSegment["0"] === 7);

// F. body guard on actual bytes (no/!spoofed content-length)
const huge = "x".repeat(6 * 1024 * 1024);
const bigRes = await call("PUT", JSON.stringify({ sessions: [], tombstones: {}, pad: huge }));
ok("oversized body -> 413", bigRes.status === 413);

// G. server cap keeps a generous number (>50) so it never prunes below a device
kv.clear();
const many = Array.from({ length: 250 }, (_, i) => mk("m" + i, i));
await put({ sessions: many, tombstones: {} });
g = await get();
ok("server cap 200 (>client 50)", g.length === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
