/**
 * Round-trip validation of the FIT encoder: encode a synthetic session, then
 * decode it with an independent mini-parser — verify header, walk every
 * definition/data record to the exact end of the data section, and check both
 * CRCs. Exits non-zero on any failure.
 */
import { encodeFitActivity } from "../tmp/fit.bundle.mjs";

// ---- synthetic session: 10 min, 2 laps, 1 Hz HR ----
const start = Date.UTC(2026, 5, 12, 8, 0, 0);
const durSec = 600;
const series = [];
for (let i = 0; i < durSec; i++) {
  series.push({
    t: start + i * 1000,
    hr: Math.round(130 + 30 * Math.sin(i / 60)),
    alpha1: null,
    speedMps: 2.8 + 0.3 * Math.sin(i / 30),
    brpm: null,
    zone: 3,
    cadence: Math.round(170 + 6 * Math.sin(i / 20)),
  });
}
const summary = {
  id: "test",
  startedAt: start,
  endedAt: start + durSec * 1000,
  durationSec: durSec,
  mode: "workout",
  adherencePct: 80,
  planTitle: "Test",
  avgHr: 142,
  maxHr: 168,
  distanceM: 1700,
  kcal: 120,
  zoneTimeSec: [0, 0, 600, 0, 0],
  decouplingPct: null,
  minAlpha1: null,
  avgBrpm: null,
  intervalCount: 2,
  segments: [
    { index: 0, kind: "run", label: "Int 1", startT: start, endT: start + 300000, splitSec: 300, avgHr: 138, maxHr: 150, avgAlpha1: null, distanceM: 0 },
    { index: 1, kind: "run", label: "Int 2", startT: start + 300000, endT: start + 600000, splitSec: 300, avgHr: 148, maxHr: 168, avgAlpha1: null, distanceM: 0 },
  ],
  series: [],
};

const bytes = encodeFitActivity(summary, series);
console.log(`encoded ${bytes.length} bytes`);

// ---- independent decoder ----
const CRC_TABLE = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400];
function crc16(buf, from, to, crc = 0) {
  for (let i = from; i < to; i++) {
    const b = buf[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc & 0xffff;
}

let fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// header
const hdrSize = bytes[0];
if (hdrSize !== 14) fail(`header size ${hdrSize}`);
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
const dataSize = dv.getUint32(4, true);
const magic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
if (magic !== ".FIT") fail(`magic ${magic}`);
const hdrCrc = dv.getUint16(12, true);
if (hdrCrc !== crc16(bytes, 0, 12)) fail("header CRC mismatch");
if (bytes.length !== 14 + dataSize + 2) fail(`length ${bytes.length} != 14+${dataSize}+2`);

// file CRC over header+data
const fileCrc = dv.getUint16(14 + dataSize, true);
if (fileCrc !== crc16(bytes, 0, 14 + dataSize)) fail("file CRC mismatch");

// walk records
const SIZE = { 0x00: 1, 0x02: 1, 0x84: 2, 0x86: 4 };
let off = 14;
const end = 14 + dataSize;
const defs = {}; // local -> {global, fields:[{num,size,type}]}
const counts = {};
const hrs = [];
let firstTs = null, lastTs = null;

while (off < end) {
  const hdr = bytes[off++];
  if (hdr & 0x80) fail("compressed timestamp header unexpected");
  const local = hdr & 0x0f;
  if (hdr & 0x40) {
    // definition
    off++; // reserved
    const arch = bytes[off++];
    if (arch !== 0) fail("non-LE arch");
    const global = dv.getUint16(off, true); off += 2;
    const n = bytes[off++];
    const fields = [];
    for (let i = 0; i < n; i++) {
      const num = bytes[off++], size = bytes[off++], type = bytes[off++];
      if (SIZE[type] == null) fail(`unknown base type 0x${type.toString(16)}`);
      if (SIZE[type] !== size) fail(`size mismatch field ${num}`);
      fields.push({ num, size, type });
    }
    defs[local] = { global, fields };
  } else {
    const def = defs[local];
    if (!def) fail(`data for undefined local ${local}`);
    counts[def.global] = (counts[def.global] || 0) + 1;
    for (const f of def.fields) {
      let v;
      if (f.size === 1) v = bytes[off];
      else if (f.size === 2) v = dv.getUint16(off, true);
      else v = dv.getUint32(off, true);
      off += f.size;
      if (def.global === 20) { // record
        if (f.num === 3 && v !== 0xff) hrs.push(v);
        if (f.num === 253) { if (firstTs === null) firstTs = v; lastTs = v; }
      }
    }
  }
}
if (off !== end) fail(`walk ended at ${off}, expected ${end}`);

console.log("message counts by global:", counts);
console.log(`records: ${counts[20] ?? 0}, HR values: ${hrs.length}, hr[0]=${hrs[0]}, span=${lastTs - firstTs}s`);

const expect = (cond, msg) => { if (!cond) fail(msg); };
expect(counts[0] === 1, "file_id count");
expect(counts[21] === 2, "event count (start+stop)");
expect(counts[20] === 600, `record count ${counts[20]}`);
expect(counts[19] === 2, "lap count");
expect(counts[18] === 1, "session count");
expect(counts[34] === 1, "activity count");
expect(hrs.length === 600, "hr field count");
expect(lastTs - firstTs === 599, `record span ${lastTs - firstTs}`);
// FIT timestamp sanity: 2026-06-12 ≈ 1.15e9 in FIT epoch
expect(firstTs > 1.1e9 && firstTs < 1.3e9, `fit timestamp range ${firstTs}`);

console.log("PASS — FIT structure, CRCs, counts and timestamps all valid");
