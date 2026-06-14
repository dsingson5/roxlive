// Verifies sync/worker.js: keyless crew-allowlist + origin gate, server-side
// union (no clobber), tombstone deletes, body guard, cap, RPE field-merge.
// Run: node tools/test-sync.mjs
import worker from "../sync/worker.js";

const ORIGIN = "https://dsingson5.github.io";
function makeEnv(extra = {}) {
  const kv = new Map();
  return {
    ALLOW_ORIGIN: ORIGIN,
    HISTORY: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => void kv.set(k, v) },
    ...extra,
  };
}
let env = makeEnv();

const base = (user) => `https://w/history?user=${user}`;
const mk = (id, ended, rpe) => ({ id, endedAt: ended, durationSec: 1, mode: "workout", ...(rpe ? { rpe } : {}) });
const call = (method, url, { body, headers } = {}) =>
  worker.fetch(new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body }), env);
const putD = (obj) => call("PUT", base("david"), { body: JSON.stringify(obj) });
const getD = async () => (await (await call("GET", base("david"))).json()).sessions;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL:", name); } };

// Access gate ----------------------------------------------------------------
ok("unknown user -> 403", (await call("GET", base("nobody"))).status === 403);
ok("bad user format -> 403", (await call("GET", base("Bad_User"))).status === 403);
ok("crew user keyless -> 200", (await call("GET", base("david"))).status === 200);
ok("matching Origin -> 200", (await call("GET", base("david"), { headers: { Origin: ORIGIN } })).status === 200);
ok("foreign Origin -> 403", (await call("GET", base("david"), { headers: { Origin: "https://evil.com" } })).status === 403);

// Round-trip + no-clobber ----------------------------------------------------
await putD({ sessions: [mk("s1", 100), mk("s2", 200)], tombstones: {} });
let g = await getD();
ok("round-trip 2 (sorted desc)", g.length === 2 && g[0].id === "s2" && g[1].id === "s1");
await putD({ sessions: [mk("s3", 300)], tombstones: {} }); // device that only knows s3
g = await getD();
ok("no-clobber union", g.map((s) => s.id).sort().join() === "s1,s2,s3");

// Tombstone delete (no resurrection) -----------------------------------------
await putD({ sessions: [mk("s2", 200), mk("s3", 300)], tombstones: { s1: 1000 } });
ok("delete via tombstone", !(await getD()).some((s) => s.id === "s1"));
await putD({ sessions: [mk("s1", 100), mk("s3", 300)], tombstones: {} }); // stale re-push of s1
ok("tombstone blocks resurrection", !(await getD()).some((s) => s.id === "s1"));

// RPE field-merge ------------------------------------------------------------
await putD({ sessions: [mk("r1", 400, { overall: 8 })], tombstones: {} });
await putD({ sessions: [mk("r1", 400, { overall: null, perSegment: { 0: 7 } })], tombstones: {} });
const r1 = (await getD()).find((s) => s.id === "r1");
ok("rpe overall survives", r1 && r1.rpe.overall === 8);
ok("rpe perSegment survives", r1 && r1.rpe.perSegment && r1.rpe.perSegment["0"] === 7);

// Body guard on real bytes ---------------------------------------------------
const huge = JSON.stringify({ sessions: [], tombstones: {}, pad: "x".repeat(6 * 1024 * 1024) });
ok("oversized body -> 413", (await call("PUT", base("david"), { body: huge })).status === 413);

// Server cap (>client 50) ----------------------------------------------------
env = makeEnv();
await putD({ sessions: Array.from({ length: 250 }, (_, i) => mk("m" + i, i)), tombstones: {} });
ok("server cap 200", (await getD()).length === 200);

// Optional key still honored when configured ---------------------------------
env = makeEnv({ SYNC_KEY: "secret" });
ok("no token allowed even if SYNC_KEY set", (await call("GET", base("david"))).status === 200);
ok("wrong token -> 401", (await call("GET", base("david"), { headers: { authorization: "Bearer nope" } })).status === 401);
ok("right token -> 200", (await call("GET", base("david"), { headers: { authorization: "Bearer secret" } })).status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
