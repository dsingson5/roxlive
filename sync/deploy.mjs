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

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const TOML = join(SYNC_DIR, "wrangler.toml");
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

// 4. Deploy -------------------------------------------------------------------
step("Deploying the Worker…");
const deployOut = cap(["deploy"]);
console.log(deployOut);
const urlMatch = deployOut.match(/https:\/\/[^\s]+\.workers\.dev/);

// 5. Done ---------------------------------------------------------------------
console.log("\n========================================================");
console.log("  Sync Worker deployed (keyless — gated by crew allow-list).");
console.log(`  URL: ${urlMatch ? urlMatch[0] : "https://roxlive-sync.<your-subdomain>.workers.dev"}`);
console.log("");
console.log("  Make sure DEFAULT_SYNC_URL in src/lib/sync.ts points to this URL,");
console.log("  then rebuild + push. Sync is then automatic for every signed-in");
console.log("  crew athlete — no per-device setup.");
console.log("  Optional — save the KV id config:");
console.log('    git add sync/wrangler.toml && git commit -m "sync: KV id" && git push');
console.log("========================================================");
