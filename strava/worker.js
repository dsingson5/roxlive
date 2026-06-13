/**
 * RoxLive Strava token broker — a tiny Cloudflare Worker.
 *
 * GitHub Pages is static, so the Strava OAuth client_secret (and the
 * code→token exchange + refresh) can't live in the browser. This Worker holds
 * the secret and exposes three POST actions the RoxLive app calls:
 *
 *   { action: "exchange", code }          -> first-time token from an auth code
 *   { action: "refresh",  refresh_token } -> a fresh access token
 *   { action: "upload",   access_token, fitBase64, filename, name, description }
 *                                         -> proxies the .FIT to Strava /uploads
 *
 * Tokens are returned to the app and stored in the user's browser only — this
 * Worker is stateless and never persists them.
 *
 * Set two secrets on the Worker (wrangler secret put / dashboard → Variables):
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
 * Optional: ALLOW_ORIGIN (defaults to "*").
 */

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_UPLOAD_URL = "https://www.strava.com/api/v3/uploads";

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400, cors);
    }

    const clientId = env.STRAVA_CLIENT_ID;
    const clientSecret = env.STRAVA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return json({ error: "Worker missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET" }, 500, cors);
    }

    try {
      if (body.action === "exchange" || body.action === "refresh") {
        const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
        if (body.action === "exchange") {
          params.set("grant_type", "authorization_code");
          params.set("code", body.code || "");
        } else {
          params.set("grant_type", "refresh_token");
          params.set("refresh_token", body.refresh_token || "");
        }
        const r = await fetch(STRAVA_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: params,
        });
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || "token error", detail: data }, r.status, cors);
        return json(
          {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at,
            athlete: data.athlete
              ? { id: data.athlete.id, firstname: data.athlete.firstname, lastname: data.athlete.lastname }
              : undefined,
          },
          200,
          cors
        );
      }

      if (body.action === "upload") {
        if (!body.access_token || !body.fitBase64) return json({ error: "missing access_token / fitBase64" }, 400, cors);
        const bytes = b64ToBytes(body.fitBase64);
        const form = new FormData();
        form.set("file", new Blob([bytes], { type: "application/octet-stream" }), body.filename || "roxlive.fit");
        form.set("data_type", "fit");
        if (body.name) form.set("name", body.name);
        if (body.description) form.set("description", body.description);
        const r = await fetch(STRAVA_UPLOAD_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${body.access_token}` },
          body: form,
        });
        const data = await r.json();
        if (!r.ok) return json({ error: data.message || "upload error", detail: data }, r.status, cors);
        return json({ id: data.id, status: data.status, activity_id: data.activity_id, error: data.error }, 200, cors);
      }

      return json({ error: "unknown action" }, 400, cors);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
