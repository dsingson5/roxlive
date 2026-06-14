/**
 * One-shot deploy of the RoxLive history-sync Worker to YOUR Cloudflare account.
 * Run it from the repo root:
 *
 *     node sync/deploy.mjs
 *
 * It will (using the wrangler CLI):
 *   1. log you in if needed (opens a browser — authorize there),
 *   2. create the KV namespace (or reuse it) and write its id into sync/wrangler.toml,
 *   3. deploy the Worker,
 *   4. print the Worker URL.
 *
 * The Worker is keyless (gated by the crew allow-list + site origin), so there's
 * no secret to set and nothing to paste into the app — sync is automatic for any
 * signed-in crew athlete once the built-in URL in src/lib/sync.ts points here.
 * Re-running is safe: it reuses the existing namespace.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const TOML = join(SYNC_DIR, "wrangler.toml");
const SECRET_FILE = join(SYNC_DIR, ".auth-secret.txt");
// shell:true is required on Windows + Node 22 to launch the npx.cmd shim (and is
// harmless elsewhere). The one-time "UV_HANDLE_CLOSING" line some Windows setups
// print is benign teardown noise, not a crash.

/** Run wrangler, capturing stdout. Throws on non-zero exit (e.g. not logged in). */
function cap(args) {
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd: SYNC_DIR,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    shell: true,
  });
}
/** Run wrangler attached to your terminal (needed for the interactive login). */
function tty(args) {
  execFileSync("npx", ["--yes", "wrangler", ...args], { cwd: SYNC_DIR, stdio: "inherit", shell: true });
}
const step = (m) => console.log(`\n→ ${m}`);

// 1. Auth + 2. KV namespace ---------------------------------------------------
step("Checking Cloudflare login…");
function listNamespaces() {
  return JSON.parse(cap(["kv", "namespace", "list"]));
}
let namespaces;
try {
  namespaces = listNamespaces(); // succeeds only when already authenticated
} catch {
  step("Logging in to Cloudflare — a browser tab will open, click Allow…");
  tty(["login"]); // real terminal → interactive OAuth
  namespaces = listNamespaces();
}

step("Ensuring the HISTORY KV namespace exists…");
let kvId = "";
const existing = namespaces.find((n) => typeof n.title === "string" && n.title.includes("HISTORY"));
if (existing) {
  kvId = existing.id;
} else {
  const out = cap(["kv", "namespace", "create", "HISTORY"]);
  const m = out.match(/id\s*=\s*"([0-9a-fA-F]{32})"|"id"\s*:\s*"([0-9a-fA-F]{32})"/);
  kvId = (m && (m[1] || m[2])) || "";
}
if (!kvId) {
  console.error("\nCould not determine the KV namespace id. Run the manual steps in sync/README.md.");
  process.exit(1);
}
console.log(`  KV namespace id: ${kvId}`);

// 3. Write the id into wrangler.toml -----------------------------------------
let toml = readFileSync(TOML, "utf8");
toml = toml
  .replace(/id\s*=\s*"REPLACE_WITH_KV_ID"/, `id = "${kvId}"`)
  .replace(/id\s*=\s*"[0-9a-fA-F]{32}"/, `id = "${kvId}"`);
writeFileSync(TOML, toml);

// 4. AUTH_SECRET (HMAC signing key for session tokens) ------------------------
// Generated once and reused (saved locally, git-ignored) so re-runs don't rotate
// it and log everyone out. Server-side only — never shipped to the app.
step("Setting the AUTH_SECRET signing key…");
let secret = existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8").trim() : "";
if (!secret) {
  secret = randomBytes(32).toString("base64url");
  writeFileSync(SECRET_FILE, secret);
}
const sec = spawnSync("npx", ["--yes", "wrangler", "secret", "put", "AUTH_SECRET"], {
  cwd: SYNC_DIR,
  input: secret + "\n",
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (sec.status !== 0) {
  console.error("Failed to set AUTH_SECRET — see wrangler output above.");
  process.exit(1);
}

// 5. Deploy -------------------------------------------------------------------
step("Deploying the Worker…");
const deployOut = cap(["deploy"]);
console.log(deployOut);
const urlMatch = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/);

// 6. Done ---------------------------------------------------------------------
console.log("\n========================================================");
console.log("  Sync + auth Worker deployed.");
console.log(`  URL: ${urlMatch ? urlMatch[0] : "https://roxlive-sync.<your-subdomain>.workers.dev"}`);
console.log("");
console.log("  Make sure DEFAULT_SYNC_URL in src/lib/sync.ts points to this URL,");
console.log("  then rebuild + push. Crew members sign in at the hub (first time:");
console.log("  password = their name) and history syncs across devices.");
console.log("  Optional — save the KV id config:");
console.log('    git add sync/wrangler.toml && git commit -m "sync: KV id" && git push');
console.log("========================================================");
