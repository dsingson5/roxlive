/**
 * Garmin FIT activity encoder — dependency-free, browser-side.
 *
 * Produces a standard .FIT activity file (protocol 1.0 features only) that
 * imports into Garmin Connect, Strava, TrainingPeaks, intervals.icu, etc.:
 *   file_id → event(start) → record stream (timestamp/HR/distance/speed)
 *   → event(stop) → laps (one per interval/segment) → session → activity
 * with the standard FIT CRC-16 trailer.
 *
 * References: FIT Protocol & Profile (Garmin FIT SDK). All multi-byte values
 * little-endian. FIT timestamps are seconds since 1989-12-31T00:00:00Z.
 */

import type { SeriesPoint, SessionSummary } from "../types";
import { modalityDef } from "./modality";

const FIT_EPOCH_OFFSET = 631065600; // unixSec - this = fit timestamp

/* ---------------- CRC-16 (FIT variant) ---------------- */

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

function crc16(bytes: ArrayLike<number>, crc = 0): number {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc & 0xffff;
}

/* ---------------- byte writer ---------------- */

class Buf {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
  }
  u32(v: number) {
    this.u8(v);
    this.u8(v >>> 8);
    this.u8(v >>> 16);
    this.u8(v >>> 24);
  }
}

type Base = "enum" | "u8" | "u16" | "u32";
const BASE_TYPE: Record<Base, number> = { enum: 0x00, u8: 0x02, u16: 0x84, u32: 0x86 };
const BASE_SIZE: Record<Base, number> = { enum: 1, u8: 1, u16: 2, u32: 4 };
const INVALID: Record<Base, number> = { enum: 0xff, u8: 0xff, u16: 0xffff, u32: 0xffffffff };

interface FieldDef {
  num: number;
  base: Base;
}

function writeDef(buf: Buf, local: number, global: number, fields: FieldDef[]) {
  buf.u8(0x40 | local); // definition header
  buf.u8(0); // reserved
  buf.u8(0); // architecture: little-endian
  buf.u16(global);
  buf.u8(fields.length);
  for (const f of fields) {
    buf.u8(f.num);
    buf.u8(BASE_SIZE[f.base]);
    buf.u8(BASE_TYPE[f.base]);
  }
}

function writeData(buf: Buf, local: number, fields: FieldDef[], values: (number | null | undefined)[]) {
  buf.u8(local); // data header
  fields.forEach((f, i) => {
    const raw = values[i];
    const v =
      raw == null || !Number.isFinite(raw) ? INVALID[f.base] : Math.max(0, Math.round(raw));
    if (f.base === "u32") buf.u32(v);
    else if (f.base === "u16") buf.u16(Math.min(v, 0xffff));
    else buf.u8(Math.min(v, 0xff));
  });
}

const toFit = (ms: number) => Math.round(ms / 1000) - FIT_EPOCH_OFFSET;

/* ---------------- message definitions ---------------- */

const FILE_ID: FieldDef[] = [
  { num: 0, base: "enum" }, // type: 4 = activity
  { num: 1, base: "u16" }, // manufacturer: 255 = development
  { num: 2, base: "u16" }, // product
  { num: 4, base: "u32" }, // time_created
];

const EVENT: FieldDef[] = [
  { num: 253, base: "u32" }, // timestamp
  { num: 0, base: "enum" }, // event: 0 = timer
  { num: 1, base: "enum" }, // event_type: 0 = start, 4 = stop_all
];

const RECORD: FieldDef[] = [
  { num: 253, base: "u32" }, // timestamp
  { num: 3, base: "u8" }, // heart_rate (bpm)
  { num: 4, base: "u8" }, // cadence (rpm/spm)
  { num: 5, base: "u32" }, // distance (m * 100)
  { num: 6, base: "u16" }, // speed (m/s * 1000)
];

const LAP: FieldDef[] = [
  { num: 254, base: "u16" }, // message_index
  { num: 253, base: "u32" }, // timestamp (lap end)
  { num: 2, base: "u32" }, // start_time
  { num: 7, base: "u32" }, // total_elapsed_time (ms)
  { num: 8, base: "u32" }, // total_timer_time (ms)
  { num: 15, base: "u8" }, // avg_heart_rate
  { num: 16, base: "u8" }, // max_heart_rate
  { num: 0, base: "enum" }, // event: 9 = lap
  { num: 1, base: "enum" }, // event_type: 1 = stop
];

const SESSION: FieldDef[] = [
  { num: 254, base: "u16" }, // message_index
  { num: 253, base: "u32" }, // timestamp
  { num: 2, base: "u32" }, // start_time
  { num: 5, base: "enum" }, // sport
  { num: 6, base: "enum" }, // sub_sport
  { num: 7, base: "u32" }, // total_elapsed_time (ms)
  { num: 8, base: "u32" }, // total_timer_time (ms)
  { num: 9, base: "u32" }, // total_distance (m * 100)
  { num: 11, base: "u16" }, // total_calories (kcal)
  { num: 16, base: "u8" }, // avg_heart_rate
  { num: 17, base: "u8" }, // max_heart_rate
  { num: 25, base: "u16" }, // first_lap_index
  { num: 26, base: "u16" }, // num_laps
];

const ACTIVITY: FieldDef[] = [
  { num: 253, base: "u32" }, // timestamp
  { num: 0, base: "u32" }, // total_timer_time (ms)
  { num: 1, base: "u16" }, // num_sessions
  { num: 2, base: "enum" }, // type: 0 = manual
  { num: 3, base: "enum" }, // event: 26 = activity
  { num: 4, base: "enum" }, // event_type: 1 = stop
];

// respiration_rate (global message 297) — breaths/min × 100. Read by Garmin
// Connect / intervals.icu (Strava ignores it). Self-describing, so any parser
// that doesn't recognize it simply skips this message.
const RESP: FieldDef[] = [
  { num: 253, base: "u32" }, // timestamp
  { num: 0, base: "u16" }, // respiration_rate (brpm * 100)
];

/* ---------------- encoder ---------------- */

export function encodeFitActivity(summary: SessionSummary, series: SeriesPoint[]): Uint8Array {
  const body = new Buf();
  const startMs = summary.startedAt;
  const elapsedMs = Math.max(1000, Math.round(summary.durationSec * 1000));
  const endMs = startMs + elapsedMs; // authoritative end = start + RoxLive's own duration
  const startFit = toFit(startMs);
  const endFit = Math.max(startFit + 1, toFit(endMs));

  // file_id — activity created by a "development" device
  writeDef(body, 0, 0, FILE_ID);
  writeData(body, 0, FILE_ID, [4, 255, 1, startFit]);

  // timer start
  writeDef(body, 1, 21, EVENT);
  writeData(body, 1, EVENT, [startFit, 0, 0]);

  // record stream — RESAMPLED to a gap-free grid spanning the WHOLE session
  // window [start, start+duration]. This makes Strava's elapsed/moving time equal
  // RoxLive's own durationSec exactly, regardless of (a) HR dropouts — the old
  // code skipped null-HR points, leaving gaps Strava auto-paused on — or (b) a
  // truncated history buffer that dropped a long ride's opening minutes. HR /
  // speed / cadence are carried forward from the most recent prior sample.
  writeDef(body, 2, 20, RECORD);
  const pts = series.filter((p) => p.t >= startMs - 2000 && p.t <= endMs + 2000).sort((a, b) => a.t - b.t);
  const totalSec = Math.round(elapsedMs / 1000);
  const stepSec = Math.max(1, Math.ceil(totalSec / 36000)); // bound the record count (~10 h @ 1 Hz)
  let dist = 0;
  let pi = 0;
  let recordCount = 0;
  let curHr: number | null = null;
  let curSpeed: number | null = null;
  let curCad: number | null = null;
  for (let sec = 0; sec <= totalSec; sec += stepSec) {
    const t = startMs + sec * 1000;
    while (pi < pts.length && pts[pi].t <= t) {
      const p = pts[pi];
      if (p.hr != null) curHr = p.hr;
      if (p.speedMps != null) curSpeed = p.speedMps;
      if (p.cadence != null) curCad = p.cadence;
      pi++;
    }
    if (curSpeed != null) dist += curSpeed * stepSec;
    writeData(body, 2, RECORD, [toFit(t), curHr, curCad, dist * 100, curSpeed != null ? curSpeed * 1000 : null]);
    recordCount++;
  }

  // respiration_rate stream (breaths/min) — captured from the HRM's R-R intervals
  // (RSA). Throttled to ~0.2 Hz; carried forward; skipped while unavailable.
  writeDef(body, 6, 297, RESP);
  let ri = 0;
  let rCur: number | null = null;
  let lastResp = -Infinity;
  for (let sec = 0; sec <= totalSec; sec += stepSec) {
    const t = startMs + sec * 1000;
    while (ri < pts.length && pts[ri].t <= t) {
      if (pts[ri].brpm != null) rCur = pts[ri].brpm;
      ri++;
    }
    if (rCur != null && rCur > 0 && t - lastResp >= 5000) {
      lastResp = t;
      writeData(body, 6, RESP, [toFit(t), Math.round(rCur * 100)]);
    }
  }

  // timer stop
  writeData(body, 1, EVENT, [endFit, 0, 4]);

  // laps — one per recorded segment/interval, else a single whole-session lap
  writeDef(body, 3, 19, LAP);
  const segs = summary.segments.filter((s) => s.splitSec != null && s.splitSec > 0);
  if (segs.length > 0) {
    segs.forEach((s, i) => {
      const ms = Math.round((s.splitSec as number) * 1000);
      writeData(body, 3, LAP, [
        i,
        toFit(s.endT ?? s.startT + ms),
        toFit(s.startT),
        ms,
        ms,
        s.avgHr,
        s.maxHr,
        9,
        1,
      ]);
    });
  } else {
    writeData(body, 3, LAP, [0, endFit, startFit, elapsedMs, elapsedMs, summary.avgHr, summary.maxHr, 9, 1]);
  }
  const numLaps = Math.max(1, segs.length);

  // session — sport / sub_sport from the session modality classification
  // (run/row/bike/… → the proper Garmin sport; mixed HYROX/CrossFit → training).
  writeDef(body, 4, 18, SESSION);
  const md = modalityDef(summary.modality ?? (summary.mode === "free" ? "other" : "mixed"));
  const sport = md.fitSport;
  const subSport = md.fitSub;
  writeData(body, 4, SESSION, [
    0,
    endFit,
    startFit,
    sport,
    subSport,
    elapsedMs,
    elapsedMs,
    summary.distanceM * 100,
    summary.kcal,
    summary.avgHr,
    summary.maxHr,
    0,
    numLaps,
  ]);

  // activity
  writeDef(body, 5, 34, ACTIVITY);
  writeData(body, 5, ACTIVITY, [endFit, elapsedMs, 1, 0, 26, 1]);

  // header (14 bytes) + body + file CRC
  const header = new Buf();
  header.u8(14); // header size
  header.u8(0x10); // protocol version 1.0
  header.u16(2195); // profile version
  header.u32(body.bytes.length); // data size (body only)
  header.u8(".".charCodeAt(0));
  header.u8("F".charCodeAt(0));
  header.u8("I".charCodeAt(0));
  header.u8("T".charCodeAt(0));
  header.u16(crc16(header.bytes)); // header CRC over first 12 bytes

  const all = [...header.bytes, ...body.bytes];
  const fileCrc = crc16(all);
  const out = new Uint8Array(all.length + 2);
  out.set(all);
  out[all.length] = fileCrc & 0xff;
  out[all.length + 1] = (fileCrc >> 8) & 0xff;

  if (recordCount === 0) {
    // still a valid file (summary-only), but flag it for the caller via console
    console.warn("[fit] exported with 0 HR records — series was empty");
  }
  return out;
}

/** Encode + trigger a browser download of the .fit file. */
export function downloadFit(summary: SessionSummary, series: SeriesPoint[]): void {
  const bytes = encodeFitActivity(summary, series);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const d = new Date(summary.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const a = document.createElement("a");
  a.href = url;
  a.download = `roxlive-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.fit`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
