# RoxLive cross-device history sync

RoxLive saves each workout to the browser's `localStorage` (per-device) **and**
mirrors it to a tiny **Cloudflare Worker + KV** store so an athlete's history
follows them to **any device they sign in on**. It's **independent of Strava**.

For the crew this is **automatic** — the app ships with the Worker URL built in,
and the Worker is **keyless** (access is gated by the crew allow-list + your site
origin, the same trust model as the Hybrid Crew hub). Any athlete who signs in at
the hub gets their history synced with **no per-device setup**. It stays
local-first: if the Worker is unreachable, history still works offline and
re-syncs later.

This guide is for **deploying / re-deploying your own Worker** (the crew's is
already live at `roxlive-sync.david-singson.workers.dev`).

---

## Easiest: one command

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and
[Node.js](https://nodejs.org). From the repo root:

```bash
node sync/deploy.mjs
```

It logs you in (browser → **Allow**), creates the KV namespace, deploys the
Worker, and prints the URL. Then point `DEFAULT_SYNC_URL` in `src/lib/sync.ts` at
that URL, rebuild, and push. No secret, nothing to paste in the app.

---

## Manual steps

```bash
cd sync
wrangler login
wrangler kv namespace create HISTORY     # paste the id into sync/wrangler.toml
wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://roxlive-sync.<your-subdomain>.workers.dev`.
Set that as `DEFAULT_SYNC_URL` in `src/lib/sync.ts`, rebuild, deploy the app.

---

## How it works

- RoxLive identifies the athlete by the Hybrid Crew sign-in (`hcUser`) — the same
  id used for the per-user local history key.
- `GET /history?user=<id>` returns that athlete's saved sessions; `PUT` merges in
  a new set. Access is allowed when the user is a known crew member and (for
  browser requests) the `Origin` matches `ALLOW_ORIGIN`.
- The **Worker merges on write** (server-side union by session id), so two devices
  pushing at once never clobber each other.
- RoxLive also merges on **pull** to fold in local-only sessions. Conflicts keep
  the richer copy and **RPE is merged field-by-field**, so an overall score on one
  device and per-segment scores on another both survive.
- **Deletes propagate** via tombstones (id → deletedAt) sent with each push, so a
  removed workout stays removed instead of being resurrected by the union.
- The cloud keeps a larger cap (200) than the on-screen list (50), so syncing
  never prunes the cloud below what a device has held.

## Notes & limits

- **Trust model.** This is a convenience store for low-sensitivity workout
  metrics, gated like the hub itself — by crew name + site origin. Anyone who
  knows the URL and a crew name could read/write that athlete's history (the data
  is crew-visible by design). Keep `ALLOW_ORIGIN` set to your site in
  `wrangler.toml` to block cross-site browser use.
- **Optional extra key.** The Worker still honors a `SYNC_KEY` secret if you set
  one (`wrangler secret put SYNC_KEY`) *and* enter it under RoxLive → Settings →
  Cross-device sync → Advanced. Keyless clients remain allowed, so this only adds
  a check for clients that do send a token.
- **Free tier** KV limits (reads/writes per day, 25 MB per value) are far above
  what a crew logging workouts will ever hit.
