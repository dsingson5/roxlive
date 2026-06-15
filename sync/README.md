# RoxLive cross-device history sync + auth

RoxLive mirrors each athlete's workout history to a tiny **Cloudflare Worker + KV**
store so it follows them to **any device they sign in on**. The Worker also does
**real password authentication**, so one login at the Hybrid Crew hub unlocks the
hub *and* sync.

How it feels for the crew:
- Sign in at the hub with your name + password. **First time, your password is your
  name** (the crew's old soft credential) — you're prompted to change it in
  RoxLive → Settings → Cross-device sync.
- A successful login stores a signed, ~90-day session. Day-to-day it's automatic
  and works offline; only the *first* login on a device needs the Worker online.

This guide is for **deploying / re-deploying the Worker** (the crew's is live at
`roxlive-sync.david-singson.workers.dev`).

---

## Easiest: one command

Free [Cloudflare](https://dash.cloudflare.com/sign-up) account + [Node.js](https://nodejs.org).
From the repo root:

```bash
node sync/deploy.mjs
```

It logs you in (browser → **Allow**), creates the KV namespace, generates + sets
the `AUTH_SECRET` signing key, and deploys. Point `DEFAULT_SYNC_URL` in
`src/lib/sync.ts` at the printed URL, rebuild, push.

---

## Manual steps

```bash
cd sync
wrangler login
wrangler kv namespace create HISTORY                 # paste the id into wrangler.toml
# 32-byte random signing key for session tokens:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" | wrangler secret put AUTH_SECRET
wrangler deploy
```

> Re-setting `AUTH_SECRET` rotates it and invalidates everyone's sessions (they
> just sign in again). `deploy.mjs` saves it to `sync/.auth-secret.txt`
> (git-ignored) and reuses it so re-runs don't log people out.

---

## Auth model

- **Passwords:** PBKDF2-SHA256 (100k iterations) + a per-user random salt, stored
  in KV (`auth:<user>`). Plaintext is never stored or logged.
- **First login** seeds the password to the athlete's own name, flagged
  `mustChange` so the app nudges them to set a real one. *Until they do, the
  account is only as private as their name.*
- **Sessions:** login returns an HMAC-SHA256-signed token `{ user, exp }`
  (`AUTH_SECRET`), good ~90 days. `/history` requires a valid token whose user
  matches the requested `?user` — real per-athlete isolation.
- **Endpoints:** `POST /login`, `POST /password` (change, needs current),
  `GET|PUT /history?user=`. Browser requests must match `ALLOW_ORIGIN`.

## Async video coaching (R2) — one-time setup

The same Worker also powers **Form Review**: athletes send a movement clip from a
strength page / RoxLive, and David reviews it from his **Coach** card (scrub,
pose overlay, telestration, angle presets, feedback). Clips live in a free
**Cloudflare R2** bucket; metadata + feedback in the existing KV.

Until the bucket exists and the Worker is redeployed, the `/review/*` routes
return `503` and the app shows *"Coach review isn't set up on the server yet."*
To turn it on (≈2 min):

```bash
cd sync
wrangler r2 bucket create roxlive-review   # the binding is already in wrangler.toml
wrangler deploy                            # redeploy so /review/* + the R2 binding go live
```

That's the whole setup — no new secrets, no client changes. After it deploys,
the **Form Review** card (Coach), the **Send to coach** button on strength A–D,
and the same button in RoxLive all start working.

Limits & privacy:
- Per-clip cap **150 MB**; the Worker keeps the **newest 30 clips per athlete**
  (older ones auto-prune from R2 + KV). R2 free tier = 10 GB — far beyond a crew.
- Isolation mirrors history: an athlete can only read/delete **their own** clips;
  **only `david`** sees the full queue and can post feedback. Clips are private —
  served only to the owner or the coach, behind the session token.
- Tell the crew their coach can see clips they send (it's a coaching tool).

## History merge

Server-side union by session id (two devices never clobber each other), tombstone
deletes (a removed workout can't be resurrected), field-merged RPE, cloud cap 200.

## Honest limits

- The hub's training pages are static files on public GitHub Pages — they can't be
  truly locked down (anyone with a file URL can read them). The password's real
  teeth are on the **sync data** (server-verified) and on raising the bar at the
  gate. Treat the training content as not-secret.
- Keep `ALLOW_ORIGIN` set to your site in `wrangler.toml`.
- Free-tier KV limits are far above a crew's usage.
