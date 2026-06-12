/**
 * Photo → structured workout, via the Claude Messages API called directly from
 * the browser (anthropic-dangerous-direct-browser-access). We force a single
 * tool call so the model must return a schema-valid workout object.
 *
 * The API key is supplied by the user and kept only in localStorage on their
 * machine — it is sent solely to api.anthropic.com.
 */

import type { ParsedWorkout } from "../types";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

export const VISION_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · fast, great value" },
  { id: "claude-opus-4-8", label: "Opus 4.8 · most accurate" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 · cheapest" },
];

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the session, e.g. 'Threshold 4×4'." },
    intervals: {
      type: "array",
      description: "Every interval/set in order. Expand repeats (e.g. '4×3min' → four separate intervals).",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name, e.g. 'Warm-up', 'Interval 2', 'Wall Balls'." },
          kind: { type: "string", enum: ["warmup", "work", "rest", "active", "cooldown"] },
          durationSec: { type: "integer", description: "Duration in seconds. If only reps are given, estimate a sensible duration." },
          targetType: { type: "string", enum: ["zone", "hr", "pace", "rpe", "none"] },
          zone: { type: ["integer", "null"], description: "HR zone 1-5 when targetType is 'zone'." },
          hrLow: { type: ["integer", "null"], description: "Lower HR bound in bpm when targetType is 'hr'." },
          hrHigh: { type: ["integer", "null"], description: "Upper HR bound in bpm when targetType is 'hr'." },
          targetLabel: { type: "string", description: "Human label exactly as written, e.g. 'Z4', '150-160 bpm', '5:30/km', 'RPE 8'." },
          notes: { type: "string", description: "Any extra cue, reps, load or instruction." },
        },
        required: ["name", "kind", "durationSec", "targetType"],
      },
    },
  },
  required: ["title", "intervals"],
} as const;

function prompt(maxHr: number): string {
  return [
    "You are reading a photo of a workout (a whiteboard, notebook, phone screenshot, or coach's plan).",
    "Extract it into a precise, ordered list of timed intervals and call the save_workout tool.",
    "Rules:",
    "- Expand every repeat into individual intervals (e.g. '4 x (3:00 hard / 2:00 easy)' → 8 intervals).",
    "- Convert durations to seconds. If a set is rep-based with no time, estimate a realistic duration and put the reps/load in notes.",
    `- For intensity: if HR zones are given use targetType 'zone' (1-5). If explicit heart rates are given use targetType 'hr' with hrLow/hrHigh in bpm. If pace or RPE is given use those types. Always also fill targetLabel with the original wording. The athlete's max HR is ${maxHr} bpm — use it only to sanity-check, do not invent zones that aren't on the page.`,
    "- Classify kind as warmup / work / rest / active / cooldown.",
    "- Keep names short. Preserve the athlete's order exactly.",
  ].join("\n");
}

export interface VisionResult {
  ok: boolean;
  workout?: ParsedWorkout;
  error?: string;
}

export async function parseWorkoutImage(opts: {
  base64: string; // raw base64, no data: prefix
  mediaType: string; // image/png | image/jpeg | image/webp | image/gif
  apiKey: string;
  model: string;
  maxHr: number;
}): Promise<VisionResult> {
  const body = {
    model: opts.model,
    max_tokens: 2048,
    tools: [
      {
        name: "save_workout",
        description: "Save the structured workout extracted from the image.",
        input_schema: TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "save_workout" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: opts.mediaType, data: opts.base64 } },
          { type: "text", text: prompt(opts.maxHr) },
        ],
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
    if (res.status === 401) msg = "Invalid API key (401). Check the key and try again.";
    if (res.status === 404) msg = `Model not found (404). Try a different model. (${msg})`;
    return { ok: false, error: msg };
  }

  let data: { content?: { type: string; input?: ParsedWorkout }[] };
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Could not parse Claude's response." };
  }

  const toolBlock = data.content?.find((b) => b.type === "tool_use" && b.input);
  if (!toolBlock?.input) {
    return { ok: false, error: "Claude didn't return a structured workout. Try a clearer photo." };
  }
  return { ok: true, workout: toolBlock.input };
}

/** Read a File into { base64, mediaType }, downscaling large images. */
export async function fileToBase64(file: File, maxEdge = 1568): Promise<{ base64: string; mediaType: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("Could not read file"));
    fr.readAsDataURL(file);
  });

  // Downscale via canvas to keep token cost + upload size reasonable.
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not decode image"));
    i.src = dataUrl;
  });

  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  if (scale >= 1) {
    // small enough — return original bytes
    const comma = dataUrl.indexOf(",");
    const mediaType = dataUrl.slice(5, dataUrl.indexOf(";"));
    return { base64: dataUrl.slice(comma + 1), mediaType };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const comma = dataUrl.indexOf(",");
    return { base64: dataUrl.slice(comma + 1), mediaType: "image/png" };
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL("image/jpeg", 0.9);
  return { base64: out.slice(out.indexOf(",") + 1), mediaType: "image/jpeg" };
}
