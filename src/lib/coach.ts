/**
 * Post-run AI analysis: send the finished session's metrics to the Claude
 * Messages API and get back a short read of the session + recovery guidance.
 *
 * Reuses the same browser-direct pattern as the photo parser (lib/vision.ts):
 * the user's own API key, kept only in localStorage, sent solely to
 * api.anthropic.com. Only the athlete's own numeric metrics are sent.
 *
 * Framed as general training guidance — NOT medical advice (the system prompt
 * enforces this and the UI repeats the disclaimer).
 */

import type { AthleteProfile, SessionSummary } from "../types";
import { modalityDef } from "./modality";
import { fmtClock } from "./format";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

const SYSTEM = [
  "You are an experienced endurance and strength coach. After a single training session you give the athlete a concise, practical read of it, using only the data provided.",
  "Cover two things: (1) a short assessment of the session — intensity and zone distribution, aerobic durability (from HR decoupling and DFA alpha-1) and, if present, recovery quality (from heart-rate recovery); (2) prioritized RECOVERY actions for the next 24-48 hours — fuelling, hydration, sleep, mobility/active-recovery vs full rest, and when + how hard to train next.",
  "Style: be specific to the numbers, brief (a few short sections with bullet points, not an essay), encouraging but honest.",
  "Boundaries: you are NOT a medical professional — do not diagnose or give medical advice. If the data looks genuinely concerning (e.g. unusually high HR for the effort, very poor recovery, symptoms), advise consulting a professional. Use the athlete's units (bpm, km, minutes).",
  "Interpretation hints (guidance, not rigid rules): HR decoupling above ~5% can signal fatigue, heat or under-fuelling; DFA alpha-1 dropping well below ~0.75 indicates high strain (around/above threshold); a 1-minute heart-rate-recovery drop above ~25-30 bpm is strong while below ~12 is poor; lots of time in Z4-5 needs more recovery than Z1-2.",
  "Data caveat: this is consumer chest-strap/optical HR, which can throw transient artifacts. Treat a single isolated high reading — especially a peak above the athlete's stated max HR — as a likely sensor glitch, NOT a clinical signal; never imply cardiac danger from one data point. Only suggest seeing a professional for a sustained, plausible pattern.",
].join(" ");

export interface CoachResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Build a compact, readable metrics block from the session for the prompt. */
function dataBlock(s: SessionSummary, p: AthleteProfile): string {
  const L: string[] = [];
  L.push(`Athlete: age ${p.age}, max HR ${p.maxHr} bpm, resting HR ${p.restHr} bpm, weight ${p.weightKg} kg.`);
  const type =
    s.mode === "hyrox" ? "HYROX simulation"
    : s.mode === "workout" ? (s.planTitle?.trim() || "guided workout")
    : s.modality && s.modality !== "mixed" ? modalityDef(s.modality).label
    : "free session";
  L.push(`Session: ${type}. Active (moving) time ${fmtClock(s.activeSec ?? s.durationSec)}.`);
  if (s.avgHr != null) {
    // Flag an implausible peak (well above the athlete's max) as a likely sensor
    // artifact so the model doesn't surface a glitch as a cardiac concern.
    const peak = s.maxHr != null ? Math.round(s.maxHr) : null;
    const peakStr = peak != null ? `, peak HR ${peak} bpm${peak > p.maxHr + 8 ? " (likely a sensor spike — above stated max)" : ""}` : "";
    L.push(`Average HR ${Math.round(s.avgHr)} bpm (${Math.round((100 * s.avgHr) / p.maxHr)}% of max)${peakStr}.`);
  }
  if (s.zoneTimeSec?.some((x) => x > 0)) {
    L.push(`Time in HR zones: ${s.zoneTimeSec.map((sec, i) => `Z${i + 1} ${Math.round(sec / 60)} min`).join(", ")}.`);
  }
  if (s.distanceM > 0) L.push(`Distance ${(s.distanceM / 1000).toFixed(2)} km.`);
  if (s.kcal) L.push(`Energy ~${Math.round(s.kcal)} kcal.`);
  if (s.adherencePct != null) L.push(`Time held inside the prescribed HR targets: ${Math.round(s.adherencePct)}% (ramp-up excluded).`);
  if (s.decouplingPct != null) L.push(`Aerobic decoupling (HR drift): ${s.decouplingPct.toFixed(1)}%.`);
  if (s.minAlpha1 != null) L.push(`Lowest DFA alpha-1: ${s.minAlpha1.toFixed(2)}.`);
  if (s.avgBrpm != null) L.push(`Average breathing rate: ${Math.round(s.avgBrpm)} breaths/min.`);
  if (s.recovery && (s.recovery.hrr30 != null || s.recovery.hrr60 != null)) {
    const r = s.recovery;
    const p2: string[] = [];
    if (r.hrr30 != null) p2.push(`-${r.hrr30} bpm at 30 s`);
    if (r.hrr60 != null) p2.push(`-${r.hrr60} bpm at 1 min`);
    L.push(`Heart-rate recovery after stopping: ${p2.join(", ")} (from peak ${r.peakHr} bpm).`);
  }
  if (s.rpe?.overall != null) L.push(`Perceived exertion (RPE, 1-10): ${s.rpe.overall}.`);
  if (s.feel) L.push(`How it felt overall: ${s.feel}.`);
  const segs = (s.segments ?? []).filter((x) => x.splitSec != null);
  if (segs.length) {
    L.push(`Splits: ${segs.map((x, i) => `${i + 1}) ${x.label} ${fmtClock(x.splitSec as number)}${x.avgHr != null ? ` @ ${Math.round(x.avgHr)} bpm` : ""}`).join("; ")}.`);
  }
  return L.join("\n");
}

export async function analyzeWorkout(opts: {
  summary: SessionSummary;
  profile: AthleteProfile;
  apiKey: string;
  model: string;
}): Promise<CoachResult> {
  const body = {
    model: opts.model,
    max_tokens: 1100,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Here is my training session. Give me a short analysis and what to do for recovery.\n\n${dataBlock(opts.summary, opts.profile)}`,
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Claude: ${(e as Error).message}` };
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = err?.error?.message || msg;
    } catch {
      /* ignore */
    }
    if (res.status === 401) msg = "Invalid API key (401). Check it in Settings.";
    if (res.status === 404) msg = `Model not found (404). Pick another model. (${msg})`;
    if (res.status === 429) msg = "Rate limited (429). Wait a moment and try again.";
    return { ok: false, error: msg };
  }

  let data: { content?: { type: string; text?: string }[] };
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Could not parse Claude's response." };
  }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) return { ok: false, error: "Claude returned an empty analysis. Try again." };
  return { ok: true, text };
}
