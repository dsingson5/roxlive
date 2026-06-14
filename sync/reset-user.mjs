/**
 * Coach account reset. Deletes an athlete's auth record so their next sign-in
 * re-seeds with their name (back to the default). Use this if someone is locked
 * out or an account was claimed before they first logged in.
 *
 *   node sync/reset-user.mjs <name>
 *
 * Their saved history (hist:<user>) is NOT touched — only the password record.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYNC_DIR = dirname(fileURLToPath(import.meta.url));
const user = (process.argv[2] || "").trim().toLowerCase();
if (!/^[a-z0-9-]{1,40}$/.test(user)) {
  console.error("Usage: node sync/reset-user.mjs <name>");
  process.exit(1);
}

const toml = readFileSync(join(SYNC_DIR, "wrangler.toml"), "utf8");
const m = toml.match(/id\s*=\s*"([0-9a-fA-F]{32})"/);
if (!m) {
  console.error("Could not find the KV namespace id in sync/wrangler.toml.");
  process.exit(1);
}
const nsId = m[1];

console.log(`Resetting auth for "${user}" (history is preserved)…`);
execFileSync("npx", ["--yes", "wrangler", "kv", "key", "delete", `auth:${user}`, "--namespace-id", nsId, "--remote"], {
  cwd: SYNC_DIR,
  stdio: "inherit",
  shell: true,
});
console.log(`Done. ${user} can sign in again with their name as the password, then set a new one.`);
