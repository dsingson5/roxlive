/**
 * Calendar → RoxLive plan import.
 *
 * The Hybrid Crew training-calendar pages (David's year calendar, the Jakarta
 * taper plans, …) live on the SAME origin as RoxLive (dsingson5.github.io), so:
 *   1. A calendar page can hand a single day's prescription to RoxLive by writing
 *      a normalized {@link IncomingWorkout} to localStorage[`roxlive.incoming.v1`]
 *      and navigating to ../roxlive/?user=<id>. RoxLive picks it up on load.
 *   2. RoxLive can fetch() a user's live calendar page and parse the embedded
 *      `const SESSIONS/TEMPLATES` (year calendar) or `const T` (taper) JSON to
 *      list every programmed day — so new workouts the coach adds to the calendar
 *      appear in RoxLive automatically, no code change needed.
 *
 * The calendars describe workouts as free text (a coach's prescription, e.g.
 * "16-min active w/u + 10×1000m @ 5:30/km / HR 152-158 · 60-90s recov"), not
 * typed intervals. {@link incomingToPlan} parses that prose into a runnable
 * {@link WorkoutPlan}: durations / HR / zone / pace pulled out where present,
 * by-feel labels otherwise. It is intentionally forgiving — anything it can't
 * parse still rides along as the interval's label/notes, and the athlete can
 * fine-tune everything in the Builder before pressing START.
 */

import type { IntervalTarget, WorkoutInterval, WorkoutIntervalKind, WorkoutPlan } from "../types";
import { guessModality, type Modality } from "./modality";

/** Handoff key (shared origin localStorage). */
export const INCOMING_KEY = "roxlive.incoming.v1";

/** What a calendar page writes for RoxLive to adopt. */
export interface IncomingWorkout {
  v: 1;
  source: "year-calendar" | "jakarta";
  title: string;
  /** ISO date (year calendar) or display date "Tue · Jun 9" (taper). */
  date?: string;
  /** phase / training-block label, e.g. "Lead-in (M1)" or "Peak". */
  phase?: string;
  /** cycle-day tag, e.g. "D3" (year calendar). */
  cycle?: string;
  /** free-text prescription prose (year calendar TEMPLATES summary). */
  summary?: string;
  /** structured sections (taper plans). */
  sections?: { label: string; items: string[] }[];
  /** coach's note. */
  note?: string;
}

/** A calendar day surfaced in RoxLive's picker (an IncomingWorkout + display bits). */
export interface CalendarEntry extends IncomingWorkout {
  /** stable key for React lists. */
  key: string;
  /** human label for the row, e.g. "Mon · Jun 8". */
  dateLabel: string;
  /** true when this is today's session. */
  isToday?: boolean;
}

/* ------------------------------------------------------------------ */
/* localStorage handoff                                                */
/* ------------------------------------------------------------------ */

/** Read + CONSUME a pending incoming workout (removed so it fires once). */
export function takeIncoming(): IncomingWorkout | null {
  try {
    const raw = localStorage.getItem(INCOMING_KEY);
    if (!raw) return null;
    localStorage.removeItem(INCOMING_KEY);
    const obj = JSON.parse(raw) as IncomingWorkout;
    if (obj && typeof obj.title === "string" && (obj.summary || obj.sections)) return obj;
  } catch {
    /* ignore */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Prose parsing                                                       */
/* ------------------------------------------------------------------ */

let idSeq = 0;
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Math.round(performance.now())}-${idSeq}`;
}

/** Per-interval duration clamp: 5 s … 4 h (real endurance sessions get long). */
function clampDur(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.min(4 * 3600, Math.max(5, Math.round(sec)));
}

const DEFAULT_DUR: Record<WorkoutIntervalKind, number> = {
  warmup: 600,
  cooldown: 300,
  rest: 60,
  active: 1200,
  work: 300,
};

/** Parse a duration out of a fragment → seconds, or null if none stated. */
export function parseDurationSec(text: string): number | null {
  const t = text.replace(/[–—]/g, "-");
  // EMOM/AMRAP N → N minutes
  const emom = t.match(/\b(?:EMOM|AMRAP|E2MOM)\s*(\d+)/i);
  if (emom) return clampDur(parseInt(emom[1], 10) * 60);
  // minutes, with optional range "35-40 min" / "16-18 min"
  let m = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*min/i);
  if (m) return clampDur(((parseFloat(m[1]) + parseFloat(m[2])) / 2) * 60);
  m = t.match(/(\d+(?:\.\d+)?)\s*-?\s*min\b/i);
  if (m) return clampDur(parseFloat(m[1]) * 60);
  // hours "1.5h" / "2 hr"
  m = t.match(/(\d+(?:\.\d+)?)\s*h(?:r|our)?s?\b/i);
  if (m) return clampDur(parseFloat(m[1]) * 3600);
  // seconds, range "60-90s" / single "75-sec" / "45 s"
  m = t.match(/(\d+)\s*-\s*(\d+)\s*(?:s\b|sec|secs|second)/i);
  if (m) return clampDur((parseInt(m[1], 10) + parseInt(m[2], 10)) / 2);
  m = t.match(/(\d+)\s*-?\s*(?:s\b|sec|secs|second)/i);
  if (m) return clampDur(parseInt(m[1], 10));
  return null;
}

/** "6 × 3 min", "10×1000m", "4 × 15m Sled" → {count, perValue, unit}. */
function parseReps(text: string): { count: number; per: number; unit: string } | null {
  const m = text.replace(/[×x✕]/gi, "x").match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(min|m\b|km|s\b|sec|secs)?/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  if (!count || count < 2 || count > 60) return null;
  return { count, per: parseFloat(m[2]), unit: (m[3] || "").toLowerCase() };
}

/** Detect a HR / zone / pace / RPE target inside a fragment. */
export function parseTarget(text: string, label: string): IntervalTarget {
  const t = text.replace(/[–—]/g, "-");
  const hr = t.match(/HR\s*(\d{2,3})\s*-\s*(\d{2,3})/i) || t.match(/(\d{2,3})\s*-\s*(\d{2,3})\s*bpm/i);
  if (hr) {
    const a = parseInt(hr[1], 10), b = parseInt(hr[2], 10);
    return { type: "hr", hrLow: Math.min(a, b), hrHigh: Math.max(a, b), label };
  }
  const z = t.match(/\bZ\s?([1-5])\b/i) || t.match(/\bzone\s*([1-5])\b/i);
  if (z) return { type: "zone", zone: parseInt(z[1], 10), label };
  if (/threshold|tempo|sub-?threshold/i.test(t)) return { type: "zone", zone: 4, label };
  if (/\beasy\b|aerobic|recovery jog|z2 jog|\bjog\b/i.test(t)) return { type: "zone", zone: 2, label };
  if (/\/\s*km|\/km|pace/i.test(t) && /\d:\d{2}/.test(t)) return { type: "pace", label };
  const rpe = t.match(/RPE\s*(\d+)/i);
  if (rpe) return { type: "rpe", label };
  return { type: "none", label };
}

const MOVE_RE = /\b(run|jog|ski|row|erg|bike|ride|cycl|swim|sled|wall ?ball|burpee|lunge|squat|carry|farmer|sandbag|deadlift|press|clean|snatch|ghd|plank|core|sit-?up|pull-?up|push-?up|kb|kettlebell|box|thruster|jump rope|skip)\b/i;

function guessKind(text: string): WorkoutIntervalKind {
  const t = text.toLowerCase();
  if (/warm[\s-]?up|\bw\/?u\b|\bwu\b|active w\/u/.test(t)) return "warmup";
  if (/cool[\s-]?down|\bc\/?d\b|\bcd\b/.test(t)) return "cooldown";
  if (/\b(rest|recover|recov|float|walk recovery|between reps|easy jog between|transition)\b/.test(t)) return "rest";
  if (/threshold|tempo|interval|\brep(s)?\b|@ ?race pace|hard|vo2|max|sprint|pickup|stride/.test(t)) return "work";
  if (/\beasy\b|\bz2\b|zone 2|aerobic|steady|\bjog\b/.test(t)) return "active";
  return "work";
}

/** Trim a fragment into a short interval name. */
function shortName(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/^[+·•\-\s]+/, "");
  if (!clean) return fallback;
  return clean.length > 42 ? clean.slice(0, 40).trimEnd() + "…" : clean;
}

/** Coach-meta fragment (no duration, reps, movement or target) → carry as note, not an interval. */
function isMeta(text: string, dur: number | null, reps: unknown, target: IntervalTarget): boolean {
  if (dur != null || reps) return false;
  if (target.type !== "none") return false;
  if (MOVE_RE.test(text)) return false;
  return true;
}

/** Build one or more intervals from a single prescription fragment. */
function intervalsFromFragment(fragment: string, sectionLabel?: string): WorkoutInterval[] {
  const text = fragment.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const kind = guessKind(text);
  const target = parseTarget(text, text.length > 60 ? text.slice(0, 58) + "…" : text);
  const reps = parseReps(text);
  const dur = parseDurationSec(text);
  const baseName = sectionLabel ? `${sectionLabel}: ${shortName(text, sectionLabel)}` : shortName(text, "Interval");
  const modality = guessModality(text);

  // Time-based reps, e.g. "6 × 3 min @ threshold, 75-sec float" → 6 work + floats.
  if (reps && (reps.unit === "min" || reps.unit === "s" || reps.unit === "sec" || reps.unit === "secs")) {
    const perSec = reps.unit === "min" ? reps.per * 60 : reps.per;
    // a recovery duration mentioned AFTER the rep spec (float/recov/jog/walk)
    const recovMatch = text.match(/(\d+)\s*-?\s*(?:s\b|sec|min)[^.]*\b(?:float|recov|recovery|jog|walk|rest|easy)\b/i)
      || text.match(/\b(?:float|recov|recovery|jog|walk|rest|easy)\b[^.]*?(\d+)\s*-?\s*(?:s\b|sec|min)/i);
    let recovSec = 0;
    if (recovMatch) {
      const n = parseInt(recovMatch[1], 10);
      recovSec = /min/i.test(recovMatch[0]) ? n * 60 : n;
    }
    const out: WorkoutInterval[] = [];
    const reps_n = Math.min(reps.count, 30);
    for (let i = 0; i < reps_n; i++) {
      out.push({
        id: uid("iv"),
        name: `${sectionLabel ? sectionLabel + ": " : ""}Rep ${i + 1}/${reps_n}`,
        kind: "work",
        durationSec: clampDur(perSec),
        target: { ...target },
        notes: i === 0 ? text : undefined,
        modality,
      });
      if (recovSec && i < reps_n - 1) {
        out.push({
          id: uid("iv"),
          name: "Recover",
          kind: "rest",
          durationSec: clampDur(recovSec),
          target: { type: "none" },
          modality,
        });
      }
    }
    // Don't silently drop a big rep count — note the cap so the coach's intent
    // stays visible in the Builder.
    if (reps_n < reps.count && out[0]) {
      out[0].notes = `${out[0].notes || text}  (capped ${reps.count}→${reps_n} reps)`;
    }
    return out;
  }

  // Single interval.
  const durationSec = dur != null ? clampDur(dur) : DEFAULT_DUR[kind];
  return [
    {
      id: uid("iv"),
      name: baseName,
      kind,
      durationSec,
      target,
      notes: text,
      modality,
    },
  ];
}

/** Split a year-calendar summary into prescription fragments. */
function splitSummary(summary: string): string[] {
  return summary
    .split(/\s*·\s*|\s*•\s*/) // middot-separated phrases
    .flatMap((chunk) => chunk.split(/\s+\+\s+/)) // "a + b + c" sub-phrases
    .map((s) => s.replace(/^[★☆»\s]+/, "").trim())
    .filter(Boolean);
}

/** Convert a calendar prescription into a runnable, editable WorkoutPlan. */
export function incomingToPlan(inc: IncomingWorkout): WorkoutPlan {
  const intervals: WorkoutInterval[] = [];
  const metaNotes: string[] = [];

  const consume = (fragment: string, sectionLabel?: string) => {
    const text = fragment.replace(/\s+/g, " ").trim();
    if (!text) return;
    const target = parseTarget(text, "");
    const dur = parseDurationSec(text);
    const reps = parseReps(text);
    if (isMeta(text, dur, reps, target)) {
      metaNotes.push(sectionLabel ? `${sectionLabel}: ${text}` : text);
      return;
    }
    for (const iv of intervalsFromFragment(fragment, sectionLabel)) {
      if (intervals.length < 60) intervals.push(iv);
    }
  };

  if (inc.source === "jakarta" && inc.sections?.length) {
    for (const sec of inc.sections) for (const item of sec.items) consume(item, sec.label);
  } else if (inc.summary) {
    for (const frag of splitSummary(inc.summary)) consume(frag);
  }
  if (inc.note) metaNotes.push(`Coach's note — ${inc.note}`);

  // Always end up with at least one runnable interval.
  if (!intervals.length) {
    intervals.push({
      id: uid("iv"),
      name: shortName(inc.title, "Workout"),
      kind: "work",
      durationSec: DEFAULT_DUR.work,
      target: { type: "none", label: inc.summary?.slice(0, 60) },
      notes: inc.summary || inc.sections?.flatMap((s) => s.items).join(" · "),
      modality: guessModality(inc.title),
    });
  }

  // Fold coach-meta into the first interval's notes so nothing is lost.
  if (metaNotes.length) {
    intervals[0].notes = [intervals[0].notes, ...metaNotes].filter(Boolean).join("  ·  ");
  }

  const distinct = new Set(intervals.map((iv) => iv.modality));
  const only = [...distinct][0];
  const modality: Modality = distinct.size === 1 && only ? (only as Modality) : "mixed";
  const titleBits = [inc.title, inc.date].filter(Boolean).join(" · ");

  return {
    id: uid("plan"),
    title: titleBits || "Calendar workout",
    source: "manual",
    createdAt: Math.round(performance.timeOrigin + performance.now()),
    intervals,
    modality,
  };
}

/* ------------------------------------------------------------------ */
/* Fetching the live calendar (for the in-RoxLive picker)              */
/* ------------------------------------------------------------------ */

/** Pull `const NAME = {…}` / `[…]` out of page HTML by balanced-brace scan. */
function extractConst(html: string, name: string): unknown {
  const decl = new RegExp(`(?:const|var|let)\\s+${name}\\s*=`).exec(html);
  if (!decl) return null;
  let i = decl.index + decl[0].length;
  while (i < html.length && html[i] !== "{" && html[i] !== "[") i++;
  if (i >= html.length) return null;
  const open = html[i];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr: string | null = null, esc = false;
  const start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  try {
    return JSON.parse(html.slice(start, i));
  } catch {
    return null;
  }
}

function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fmtISO(iso: string): string {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

type SessionRec = { template?: string; phase?: string };
type TemplateRec = { title?: string; summary?: string };

/**
 * Fetch a user's live calendar page (same origin) and list its programmed days.
 * Returns [] on any failure (offline / wrong page / parse miss) so the picker
 * simply stays empty — never throws.
 */
export async function fetchCalendarWorkouts(pageFile: string, signal?: AbortSignal): Promise<CalendarEntry[]> {
  let html: string;
  try {
    const res = await fetch(`../hybrid-crew/${pageFile}`, { credentials: "omit", signal });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  // Year calendar: SESSIONS keyed by ISO date → template; TEMPLATES has the prose.
  const sessions = extractConst(html, "SESSIONS") as Record<string, SessionRec> | null;
  const templates = extractConst(html, "TEMPLATES") as Record<string, TemplateRec> | null;
  if (sessions && templates) {
    const phaseMap = (extractConst(html, "PHASE_MAP") as Record<string, { name?: string }> | null) || {};
    const today = todayISO();
    const dates = Object.keys(sessions).sort();
    // window: a week back through three weeks ahead, centered on today
    const upcoming = dates.filter((d) => d >= today).slice(0, 24);
    const past = dates.filter((d) => d < today).slice(-6);
    const window = [...past, ...upcoming];
    const out: CalendarEntry[] = [];
    for (const date of window) {
      const s = sessions[date];
      const tpl = (s.template && templates[s.template]) || {};
      const title = tpl.title || "Session";
      if (/rest|off day|recovery day/i.test(title) && !tpl.summary) continue;
      out.push({
        v: 1,
        source: "year-calendar",
        title,
        date,
        phase: phaseMap[date]?.name || s.phase,
        summary: tpl.summary,
        key: date,
        dateLabel: fmtISO(date),
        isToday: date === today,
      });
    }
    return out;
  }

  // Taper plan: const T = { days: [ {date,title,sections,...} ] }
  const T = extractConst(html, "T") as { days?: Array<Record<string, unknown>> } | null;
  if (T && Array.isArray(T.days)) {
    return T.days.map((d, i) => {
      const sections = Array.isArray(d.sections)
        ? (d.sections as Array<{ k?: string; l?: string; items?: unknown }>).map((s) => ({
            label: (typeof s.l === "string" && s.l) || (typeof s.k === "string" && s.k) || "Block",
            items: Array.isArray(s.items) ? s.items.filter((x): x is string => typeof x === "string") : [],
          }))
        : [];
      const date = typeof d.date === "string" ? d.date : `Day ${i + 1}`;
      return {
        v: 1 as const,
        source: "jakarta" as const,
        title: (d.title as string) || "Session",
        date,
        phase: d.block as string | undefined,
        sections,
        note: d.note as string | undefined,
        key: `${i}`,
        dateLabel: date,
        isToday: false,
      };
    });
  }

  return [];
}

/* ------------------------------------------------------------------ */
/* Dev self-test                                                       */
/* ------------------------------------------------------------------ */

export function selfTestCalendarImport(): { ok: boolean; detail: string } {
  const checks: string[] = [];
  let ok = true;
  const expect = (cond: boolean, msg: string) => { if (!cond) { ok = false; checks.push("FAIL " + msg); } };

  // Year-calendar style summary with warmup, time-reps, HR target, recovery.
  const yc = incomingToPlan({
    v: 1,
    source: "year-calendar",
    title: "Z3 Sub-threshold",
    date: "2026-04-19",
    summary:
      "16-min active w/u · 6 × 3 min @ threshold, 75-sec float · HR 152-158 · 10 min easy · RR governor",
  });
  expect(yc.intervals.length >= 5, `yc intervals (${yc.intervals.length})`);
  expect(yc.intervals.some((i) => i.kind === "warmup"), "yc has warmup");
  expect(yc.intervals.filter((i) => i.name.includes("Rep")).length === 6, "yc 6 reps expanded");
  expect(yc.intervals.some((i) => i.target.type === "hr" && i.target.hrLow === 152), "yc HR target 152-158");

  // 90-min easy Z2 long run → not truncated to 60.
  const z2 = incomingToPlan({ v: 1, source: "year-calendar", title: "Z2 Base", summary: "90min @ HR 136-140 easy" });
  expect(z2.intervals[0].durationSec === 90 * 60, `z2 duration ${z2.intervals[0].durationSec}`);

  // Jakarta sections → intervals across sections.
  const jk = incomingToPlan({
    v: 1,
    source: "jakarta",
    title: "Threshold + Engine",
    date: "Wed · Jun 10",
    sections: [
      { label: "Monostructural", items: ["15 min easy", "6 × 3 min @ threshold, 75-sec float", "10 min easy"] },
      { label: "GPP", items: ["4 rounds @ race pace:", "300m Ski · 15 Wall Balls · 300m Run"] },
    ],
  });
  expect(jk.intervals.length >= 6, `jk intervals (${jk.intervals.length})`);
  expect(jk.modality === "mixed" || jk.intervals.length > 0, "jk built");

  // Empty/degenerate input still yields one interval.
  const empty = incomingToPlan({ v: 1, source: "year-calendar", title: "Mystery", summary: "" });
  expect(empty.intervals.length === 1, "empty → 1 interval");

  return { ok, detail: ok ? `${yc.intervals.length}+${jk.intervals.length} intervals parsed` : checks.join("; ") };
}
