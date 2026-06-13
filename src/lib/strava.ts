/**
 * Strava integration (client side). The secret-bearing steps run in the
 * user's Cloudflare Worker (see strava/worker.js); this module handles the
 * authorize redirect, stores tokens in localStorage, refreshes when stale, and
 * posts a finished session as a .FIT upload — always behind an explicit
 * in-app confirmation.
 */

import type { SeriesPoint, SessionSummary } from "../types";
import { encodeFitActivity } from "./fit";

const CFG_KEY = "roxlive.strava.cfg.v1";
const TOK_KEY = "roxlive.strava.tok.v1";
const STATE_KEY = "roxlive.strava.state";

export interface StravaConfig {
  clientId: string;
  workerUrl: string;
}
export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  athleteName?: string;
}

export function loadConfig(): StravaConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { clientId: "", workerUrl: "" };
}
export function saveConfig(c: StravaConfig): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({ clientId: c.clientId.trim(), workerUrl: c.workerUrl.trim() }));
  } catch {
    /* ignore */
  }
}
export function isConfigured(c = loadConfig()): boolean {
  return !!c.clientId && !!c.workerUrl;
}

export function loadTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(TOK_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}
function saveTokens(t: StravaTokens): void {
  try {
    localStorage.setItem(TOK_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}
export function disconnect(): void {
  try {
    localStorage.removeItem(TOK_KEY);
  } catch {
    /* ignore */
  }
}
export function isConnected(): boolean {
  return loadTokens() !== null;
}
export function connectedAthlete(): string | null {
  return loadTokens()?.athleteName ?? null;
}

/** The page URL Strava should redirect back to (no query/hash). */
function redirectUri(): string {
  return window.location.origin + window.location.pathname;
}

/** Kick off the OAuth authorize redirect. */
export function beginAuthorize(): void {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return;
  const state = Math.random().toString(36).slice(2);
  try {
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:write,read",
    state,
  });
  window.location.href = `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

async function callWorker(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const res = await fetch(cfg.workerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Worker HTTP ${res.status}`);
  return data as Record<string, unknown>;
}

/**
 * If the URL carries a Strava ?code (and matching state), exchange it for
 * tokens and clean the URL. Returns "connected" | "error" | null (no callback).
 */
export async function handleRedirectIfPresent(): Promise<{ status: "connected" | "error"; message?: string } | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (!code && !err) return null;

  // Always clean the URL so a refresh doesn't re-trigger.
  const clean = window.location.origin + window.location.pathname;
  window.history.replaceState({}, "", clean);

  if (err) return { status: "error", message: `Strava authorization was ${err}.` };

  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* ignore */
  }
  if (expected && state && expected !== state) {
    return { status: "error", message: "Strava state mismatch — please try connecting again." };
  }
  if (!isConfigured()) return { status: "error", message: "Strava isn't configured (Client ID / Worker URL)." };

  try {
    const data = await callWorker("exchange", { code });
    const athlete = data.athlete as { firstname?: string; lastname?: string } | undefined;
    saveTokens({
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      expires_at: data.expires_at as number,
      athleteName: athlete ? `${athlete.firstname ?? ""} ${athlete.lastname ?? ""}`.trim() : undefined,
    });
    return { status: "connected" };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

async function freshAccessToken(): Promise<string> {
  const tok = loadTokens();
  if (!tok) throw new Error("Not connected to Strava.");
  const now = Math.floor(Date.now() / 1000);
  if (tok.expires_at - 60 > now) return tok.access_token;
  // refresh
  const data = await callWorker("refresh", { refresh_token: tok.refresh_token });
  const next: StravaTokens = {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string) || tok.refresh_token,
    expires_at: data.expires_at as number,
    athleteName: tok.athleteName,
  };
  saveTokens(next);
  return next.access_token;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export interface PostResult {
  ok: boolean;
  uploadId?: number;
  status?: string;
  error?: string;
}

/** Upload a finished session to Strava as a .FIT (call only after user confirms). */
export async function postActivity(
  summary: SessionSummary,
  series: SeriesPoint[],
  opts: { name: string; description: string }
): Promise<PostResult> {
  try {
    const access = await freshAccessToken();
    const bytes = encodeFitActivity(summary, series.length ? series : summary.series);
    const data = await callWorker("upload", {
      access_token: access,
      fitBase64: bytesToBase64(bytes),
      filename: `roxlive-${summary.id}.fit`,
      name: opts.name,
      description: opts.description,
    });
    if (data.error) return { ok: false, error: String(data.error) };
    return { ok: true, uploadId: data.id as number, status: (data.status as string) || "processing" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
