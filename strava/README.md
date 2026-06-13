# RoxLive ↔ Strava setup (one time, ~10 min)

RoxLive posts finished workouts to Strava **only when you tap "Post to Strava"
and confirm**. Because RoxLive is a static site, the Strava client secret and
token exchange live in a tiny serverless **Cloudflare Worker** (free) instead of
the browser. Set it up once.

## 1. Register a Strava API application

1. Go to <https://www.strava.com/settings/api> and create an app.
2. Fill in:
   - **Application Name**: RoxLive (anything)
   - **Category**: Training
   - **Website**: `https://dsingson5.github.io/roxlive/`
   - **Authorization Callback Domain**: `dsingson5.github.io`  ← exactly this, no `https://`, no path
3. Note your **Client ID** and **Client Secret**.

## 2. Deploy the Worker

**Option A — dashboard (no install):**
1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**. Name it `roxlive-strava`, Deploy.
2. **Edit code**, paste the contents of [`worker.js`](worker.js), Deploy.
3. Worker → **Settings → Variables and Secrets** → add **encrypted** vars:
   - `STRAVA_CLIENT_ID` = your client id
   - `STRAVA_CLIENT_SECRET` = your client secret
   - *(optional)* `ALLOW_ORIGIN` = `https://dsingson5.github.io`
4. Copy your Worker URL, e.g. `https://roxlive-strava.<you>.workers.dev`.

**Option B — wrangler CLI:**
```sh
npm i -g wrangler
cd strava
wrangler deploy worker.js --name roxlive-strava --compatibility-date 2024-11-01
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
```

## 3. Connect in RoxLive

1. Open <https://dsingson5.github.io/roxlive/> → **⚙ Settings → Strava**.
2. Paste your **Client ID** and the **Worker URL**, **Save**.
3. Tap **Connect Strava** → approve on Strava → you're returned, connected.

## 4. Post a workout

Finish a session → **Session Complete** → **Post to Strava** → confirm. The
activity uploads with HR + cadence and your interval laps. Nothing ever posts
without that explicit confirmation.

### Notes
- Tokens (access + refresh) are stored **only in your browser**; the Worker is
  stateless and never keeps them.
- Scope requested is `activity:write` (upload) + `read`. RoxLive never reads or
  deletes your other activities.
- Free Cloudflare Workers allow 100k requests/day — far beyond personal use.
