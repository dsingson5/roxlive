/**
 * One-shot deploy of the RoxLive history-sync Worker to YOUR Cloudflare account.
 * Run it from the repo root:
 *
 *     node sync/deploy.mjs
 *
 * It will (using the wrangler CLI):
 *   1. log you in (opens a browser the first time — authorize there),
 *   2. create the KV namespace (or reuse it) and write its id into sync/wrangler.toml,
 *   3. generate + set the SYNC_KEY secret (saved locally to sync/.sync-key.txt),
 *   4. deploy the Worker,
 *   5. print the Sync URL + key to paste into RoxLive → Settings → Cross-device sync.
 *
 * Re-running is safe: it reuses the existing namespace and key.
 * Nothing here is committed for you — after it succeeds you can commit the filled-in
 * sync/wrangler.toml (the KV id is not secret) so the config is saved.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const TOML = join(SYNC_DIR, "wrangler.toml");
const KEY_FILE = join(SYNC_DIR, ".sync-key.txt");
const isWin = process.platform === "win32";

function wrangler(args, { capture = true } = {}) {
  // npx resolves wrangler without a global install; shell needed for npx on Windows.
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd: SYNC_DIR,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: isWin,
  });
}

function step(msg) {
  console.log(`\n→ ${msg}`);
}

// 1. Auth ---------------------------------------------------------------------
step("Checking Cloudflare login…");
let loggedIn = true;
try {
  wrangler(["whoami"]);
} catch {
  loggedIn = false;
}
if (!loggedIn) {
  step("Opening browser to log in to Cloudflare — click Allow there…");
  wrangler(["login"], { capture: false });
}

// 2. KV namespace -------------------------------------------------------------
step("Ensuring the HISTORY KV namespace exists…");
let kvId = "";
const idRe = /id\s*=\s*"([0-9a-fA-F]{32})"|"id"\s*:\s*"([0-9a-fA-F]{32})"/;

try {
  const out = wrangler(["kv", "namespace", "create", "HISTORY"]);
  const m = out.match(idRe);
  kvId = (m && (m[1] || m[2])) || "";
} catch {
  /* probably already exists — fall back to the list below */
}
if (!kvId) {
  try {
    const list = JSON.parse(wrangler(["kv", "namespace", "list"]));
    const found = list.find((n) => typeof n.title === "string" && n.title.includes("HISTORY"));
    if (found) kvId = found.id;
  } catch {
    /* ignore */
  }
}
if (!kvId) {
  console.error(
    "\nCould not determine the KV namespace id automatically.\n" +
      "Run `npx wrangler kv namespace create HISTORY` in the sync/ folder,\n" +
      "paste the printed id into sync/wrangler.toml (replace REPLACE_WITH_KV_ID),\n" +
      "then re-run this script."
  );
  process.exit(1);
}
console.log(`  KV namespace id: ${kvId}`);

// 3. Write the id into wrangler.toml -----------------------------------------
let toml = readFileSync(TOML, "utf8");
toml = toml.replace(/id\s*=\s*"REPLACE_WITH_KV_ID"/, `id = "${kvId}"`).replace(/id\s*=\s*"[0-9a-fA-F]{32}"/, `id = "${kvId}"`);
writeFileSync(TOML, toml);

// 4. SYNC_KEY secret ----------------------------------------------------------
step("Setting the SYNC_KEY secret…");
let key = "";
if (existsSync(KEY_FILE)) key = readFileSync(KEY_FILE, "utf8").trim();
if (!key) {
  key = randomBytes(24).toString("base64url");
  writeFileSync(KEY_FILE, key);
}
const sec = spawnSync("npx", ["--yes", "wrangler", "secret", "put", "SYNC_KEY"], {
  cwd: SYNC_DIR,
  input: key + "\n",
  stdio: ["pipe", "inherit", "inherit"],
  shell: isWin,
});
if (sec.status !== 0) {
  console.error("Failed to set SYNC_KEY secret — see wrangler output above.");
  process.exit(1);
}

// 5. Deploy -------------------------------------------------------------------
step("Deploying the Worker…");
wrangler(["deploy"], { capture: false });

// 6. Done ---------------------------------------------------------------------
console.log("\n========================================================");
console.log("  Cross-device sync deployed. In RoxLive on EACH device:");
console.log("  Settings (gear) -> Cross-device sync");
console.log("");
console.log("    Sync URL:  https://roxlive-sync.<your-subdomain>.workers.dev");
console.log("               (use the exact workers.dev URL printed just above)");
console.log(`    Sync key:  ${key}`);
console.log("");
console.log("  The key is also saved in sync/.sync-key.txt (git-ignored).");
console.log("  Optional: commit the filled-in config so it's saved:");
console.log("    git add sync/wrangler.toml && git commit -m \"sync: KV id\" && git push");
console.log("========================================================");
