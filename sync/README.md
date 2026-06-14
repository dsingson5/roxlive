# RoxLive cross-device history sync

By default RoxLive saves each workout to the browser's `localStorage`, which is
per-device. This optional add-on stores each athlete's history in a tiny
**Cloudflare Worker + KV** store so it follows them to **any device they sign in
on**. It is **independent of Strava** — you don't need Strava for this.

It's **opt-in and local-first**: until you fill in the two fields in
*RoxLive → Settings → Cross-device sync*, nothing changes and everything keeps
working offline. Once configured, RoxLive merges the cloud copy in on load and
pushes after every change.

---

## Easiest: one command

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and
[Node.js](https://nodejs.org) (already required to build RoxLive). From the repo
root:

```bash
node sync/deploy.mjs
```

It logs you in (opens a browser the first time — click **Allow**), creates the KV
namespace, generates + sets the `SYNC_KEY` secret, deploys the Worker, and prints
your **Sync URL + key**. Re-running is safe. Then skip to step 5.

---

## Manual steps (if you'd rather do it by hand)

### 1. Prerequisites

- A free Cloudflare account + Node.js with Wrangler (`npm i -g wrangler`, then `wrangler login`).

### 2. Create the KV store

```bash
cd sync
wrangler kv namespace create HISTORY
```

Copy the printed `id` into `sync/wrangler.toml` (replace `REPLACE_WITH_KV_ID`).

### 3. Set the shared sync key (a secret)

Pick a long random string — the password the crew's browsers use to talk to your
Worker:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
wrangler secret put SYNC_KEY    # paste the random string when prompted
```

### 4. Deploy

```bash
wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://roxlive-sync.<your-subdomain>.workers.dev`.

## 5. Turn it on in RoxLive

On **each device**, open RoxLive → **Settings (gear)** → **Cross-device sync**:

- **Sync URL** — the Worker URL from step 4.
- **Sync key** — the same random string from step 3.

Save. From then on, whoever is signed in (their Hybrid Crew name) gets their
history pulled from the cloud on load and pushed after each workout. Tap
**Sync now** to force a refresh.

---

## How it works

- RoxLive identifies the athlete by the Hybrid Crew sign-in (`hcUser`), the same
  id used for the per-user local history key.
- `GET /history?user=<id>` returns that athlete's saved sessions; `PUT` replaces
  them. Both require `Authorization: Bearer <SYNC_KEY>`.
- The **Worker merges on write** (`PUT` does a server-side read-merge-write,
  union by session id), so two devices pushing at once never clobber each other.
- RoxLive also merges on **pull** to fold in any local-only sessions not yet
  pushed. Conflicts keep the richer copy and **RPE is merged field-by-field**, so
  an overall score logged on one device and per-segment scores on another both
  survive.
- **Deletes propagate** via tombstones (id → deletedAt) sent with each push, so a
  removed workout stays removed instead of being resurrected by the union.
- The cloud keeps a larger cap (200) than the on-screen list (50), so syncing
  never prunes the cloud below what a device has held.

## Notes & limits

- **Soft secret.** `SYNC_KEY` lives in each crew member's browser and is sent
  from the page, so treat workout data as crew-visible. It keeps the open
  internet out; it is not bank-grade auth. Set `ALLOW_ORIGIN` in `wrangler.toml`
  to your site to tighten CORS.
- **Free tier** KV limits (reads/writes per day, 25 MB per value) are far above
  what a crew of athletes logging workouts will ever hit.
- Rotating the key: `wrangler secret put SYNC_KEY` again, then update the Sync
  key field on each device.
