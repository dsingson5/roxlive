/**
 * One-shot deploy of the RoxLive history-sync Worker to YOUR Cloudflare account.
 * Run it from the repo root:
 *
 *     node sync/deploy.mjs
 *
 * It will (using the wrangler CLI):
 *   1. log you in if needed (opens a browser — authorize there),
 *   2. create the KV namespace (or reuse it) and write its id into sync/wrangler.toml,
 *   3. generate + set the SYNC_KEY secret (saved locally to sync/.sync-key.txt),
 *   4. deploy the Worker,
 *   5. print the Sync URL + key to paste into RoxLive → Settings → Cross-device sync.
 *
 * Re-running is safe: it reuses the existing namespace and key.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const TOML = join(SYNC_DIR, "wrangler.toml");
const KEY_FILE = join(SYNC_DIR, ".sync-key.txt");
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

// 4. SYNC_KEY secret ----------------------------------------------------------
step("Setting the SYNC_KEY secret…");
let key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "";
if (!key) {
  key = randomBytes(24).toString("base64url");
  writeFileSync(KEY_FILE, key);
}
const sec = spawnSync(NPX, ["--yes", "wrangler", "secret", "put", "SYNC_KEY"], {
  cwd: SYNC_DIR,
  input: key + "\n",
  stdio: ["pipe", "inherit", "inherit"],
});
if (sec.status !== 0) {
  console.error("Failed to set SYNC_KEY — see wrangler output above.");
  process.exit(1);
}

// 5. Deploy -------------------------------------------------------------------
step("Deploying the Worker…");
const deployOut = cap(["deploy"]);
console.log(deployOut);
const urlMatch = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/);

// 6. Done ---------------------------------------------------------------------
console.log("\n========================================================");
console.log("  Cross-device sync deployed. In RoxLive on EACH device:");
console.log("  Settings (gear) -> Cross-device sync");
console.log("");
console.log(`    Sync URL:  ${urlMatch ? urlMatch[0] : "https://roxlive-sync.<your-subdomain>.workers.dev"}`);
console.log(`    Sync key:  ${key}`);
console.log("");
console.log("  The key is also saved in sync/.sync-key.txt (git-ignored).");
console.log("  Optional — commit the filled-in config so it's saved:");
console.log('    git add sync/wrangler.toml && git commit -m "sync: KV id" && git push');
console.log("========================================================");
