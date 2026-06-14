// Verifies sync/worker.js auth + sync: PBKDF2 login (seed=name), password change,
// HMAC session tokens with per-user epoch revocation, token-gated history,
// per-user isolation, origin gate, prototype-safe tombstones, merge/RPE.
// Run: node tools/test-sync.mjs
import worker from "../sync/worker.js";

const ORIGIN = "https://dsingson5.github.io";
function makeEnv(extra = {}) {
  const kv = new Map();
  return {
    AUTH_SECRET: "test-secret-xyz",
    ALLOW_ORIGIN: ORIGIN,
    HISTORY: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => void kv.set(k, v) },
    _kv: kv,
    ...extra,
  };
}
let env = makeEnv();

const J = (method, path, { body, headers, raw } = {}) =>
  worker.fetch(new Request("https://w" + path, { method, headers: { "content-type": "application/json", ...headers }, body: raw != null ? raw : body == null ? undefined : JSON.stringify(body) }), env);
const login = (user, password) => J("POST", "/login", { body: { user, password } });
const chpw = (user, currentPassword, newPassword) => J("POST", "/password", { body: { user, currentPassword, newPassword } });
const bearer = (t) => ({ authorization: "Bearer " + t });

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("FAIL:", n); } };
const tok = async (u, p) => (await (await login(u, p)).json()).token;

// 0. config guard --------------------------------------------------------------
{ const e2 = makeEnv(); delete e2.AUTH_SECRET; const save = env; env = e2;
  ok("missing AUTH_SECRET -> 500", (await login("david", "david")).status === 500); env = save; }

// 1. login / seeding -----------------------------------------------------------
ok("unknown user -> 403", (await login("nobody", "x")).status === 403);
ok("first login wrong pw -> 401", (await login("david", "notdavid")).status === 401);
{ const d = await (await login("david", "david")).json();
  ok("first login seeds w/ name", !!d.token && d.mustChange === true); }
ok("wrong pw -> 401", (await login("david", "wrong")).status === 401);
ok("foreign origin -> 403", (await J("POST", "/login", { body: { user: "david", password: "david" }, headers: { Origin: "https://evil.com" } })).status === 403);

// 2. change password requires an existing account ------------------------------
ok("change before any login -> 401", (await chpw("carla", "carla", "s3cret!")).status === 401);
ok("new pw too short -> 400", (await chpw("david", "david", "abc")).status === 400);
ok("new pw == name -> 400", (await chpw("david", "david", "David")).status === 400);
ok("change wrong current -> 401", (await chpw("david", "nope", "s3cret!")).status === 401);
ok("change pw -> 200", (await chpw("david", "david", "s3cret!")).status === 200);
ok("login old name now -> 401", (await login("david", "david")).status === 401);
{ const d = await (await login("david", "s3cret!")).json();
  ok("login new pw -> 200, not mustChange", !!d.token && d.mustChange === false); }

// 3. token epoch revocation (password change invalidates old tokens) -----------
const staleTok = await tok("david", "s3cret!");
ok("token valid before change", (await J("GET", "/history?user=david", { headers: bearer(staleTok) })).status === 200);
await chpw("david", "s3cret!", "s3cret2!");
ok("old token revoked after pw change -> 401", (await J("GET", "/history?user=david", { headers: bearer(staleTok) })).status === 401);
const dTok = await tok("david", "s3cret2!");
ok("fresh token works -> 200", (await J("GET", "/history?user=david", { headers: bearer(dTok) })).status === 200);

// 4. token-gated history + isolation -------------------------------------------
const fTok = await tok("fayth", "fayth");
ok("no token -> 401", (await J("GET", "/history?user=david")).status === 401);
ok("tampered token -> 401", (await J("GET", "/history?user=david", { headers: bearer(dTok.slice(0, -2) + "xy") })).status === 401);
ok("david token for fayth -> 401 (isolation)", (await J("GET", "/history?user=fayth", { headers: bearer(dTok) })).status === 401);

// 5. merge / tombstones / RPE --------------------------------------------------
const mk = (id, ended, rpe) => ({ id, endedAt: ended, durationSec: 1, mode: "workout", ...(rpe ? { rpe } : {}) });
const putD = (obj) => J("PUT", "/history?user=david", { body: obj, headers: bearer(dTok) });
const getD = async () => (await (await J("GET", "/history?user=david", { headers: bearer(dTok) })).json()).sessions;
await putD({ sessions: [mk("s1", 100), mk("s2", 200)], tombstones: {} });
await putD({ sessions: [mk("s3", 300)], tombstones: {} });
ok("no-clobber union", (await getD()).map((s) => s.id).sort().join() === "s1,s2,s3");
await putD({ sessions: [mk("s1", 100)], tombstones: { s2: 1000 } });
ok("tombstone delete", !(await getD()).some((s) => s.id === "s2"));
await putD({ sessions: [mk("s2", 200)], tombstones: {} });
ok("tombstone blocks resurrection", !(await getD()).some((s) => s.id === "s2"));
await putD({ sessions: [mk("r1", 400, { overall: 8 })], tombstones: {} });
await putD({ sessions: [mk("r1", 400, { overall: null, perSegment: { 0: 7 } })], tombstones: {} });
{ const r1 = (await getD()).find((s) => s.id === "r1");
  ok("rpe field-merge", r1 && r1.rpe.overall === 8 && r1.rpe.perSegment["0"] === 7); }
ok("fayth isolated empty", (await (await J("GET", "/history?user=fayth", { headers: bearer(fTok) })).json()).sessions.length === 0);

// 6. prototype-safe tombstones -------------------------------------------------
const eTok = await tok("erika", "erika");
const putE = (obj) => J("PUT", "/history?user=erika", { body: obj, headers: bearer(eTok) });
const getE = async () => (await (await J("GET", "/history?user=erika", { headers: bearer(eTok) })).json()).sessions;
// raw JSON so the "__proto__" key is real (a {__proto__:n} object literal is ignored by JS)
await J("PUT", "/history?user=erika", { headers: bearer(eTok), raw: '{"sessions":[{"id":"toString","endedAt":1},{"id":"__proto__","endedAt":2},{"id":"normal","endedAt":3}],"tombstones":{}}' });
ok("built-in-name ids not dropped", (await getE()).map((s) => s.id).sort().join() === "__proto__,normal,toString");
await J("PUT", "/history?user=erika", { headers: bearer(eTok), raw: '{"sessions":[],"tombstones":{"toString":9,"__proto__":9}}' });
{ const ids = (await getE()).map((s) => s.id).sort().join();
  ok("built-in-name ids can be tombstoned", ids === "normal"); }

// 7. body guard ----------------------------------------------------------------
ok("oversized body -> 413", (await J("PUT", "/history?user=david", { headers: bearer(dTok), body: { sessions: [], pad: "x".repeat(6 * 1024 * 1024) } })).status === 413);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
