/**
 * MetricsEngine — the real-time core. Ingests HR / pace samples, maintains
 * rolling buffers, and emits a single MetricsSnapshot the UI renders from.
 *
 * Light metrics (HR, zone, distance, kcal, interval state) update every tick.
 * Heavy metrics (DFA-α1, HRV, respiration, decoupling) are throttled to once
 * every HEAVY_MS to keep the main thread smooth at high notification rates.
 */

import type {
  AthleteProfile,
  HRSample,
  PaceSample,
  MetricsSnapshot,
  SeriesPoint,
  DfaResult,
  HrvResult,
  RespirationResult,
  DecouplingResult,
  RecoveryResult,
} from "../types";
import { computeDFA } from "./dfa";
import { computeHRV } from "./hrv";
import { computeRespiration } from "./respiration";
import { computeDecoupling, type EffSample } from "./decoupling";
import { IntervalDetector } from "./intervals";
import { zoneBounds, zoneForHr, pctMax } from "./zones";

const RR_WINDOW_SEC = 120; // DFA / HRV / respiration rolling window
const HEAVY_MS = 1500; // throttle for heavy metrics
const SERIES_MS = 1000; // 1 Hz history cadence
const MAX_SERIES = 60 * 60 * 4; // 4 h @ 1 Hz — long rides/bricks keep their FULL trace
//   (the old 90-min cap silently dropped the opening minutes of longer sessions,
//    which truncated the exported .FIT and made Strava read a too-short duration).
//   The live chart only renders a rolling window, so a larger buffer is cheap.

interface Stamped {
  t: number;
  v: number;
}

export class MetricsEngine {
  private profile: AthleteProfile;
  private detector: IntervalDetector;

  private rr: Stamped[] = []; // timestamped R-R intervals (ms)
  private effBuf: EffSample[] = []; // 1 Hz {t,hr,speed} for decoupling

  private hr: number | null = null;
  private hrT = 0; // timestamp of the last HR sample (for staleness checks)
  private lastSpeed: number | null = null;
  private cadence: number | null = null;
  private cadenceT = 0;
  private bodyTemp: number | null = null;
  private bodyTempT = 0;

  private startT = 0;
  private lastTick = 0;
  private running = false;
  private paused = false; // app-level pause: HR keeps reading, but active time / trace freeze
  private activeSec = 0; // time actually recording (excludes paused spans) — used for Strava

  // Heart-rate recovery (HRR): captured from an effort-end anchor (pause/stop)
  // while the HRM keeps streaming. Independent of the paused/active accounting.
  private recStartT: number | null = null;
  private recPeak = 0;
  private recHr30: number | null = null;
  private recHr60: number | null = null;
  private recSamples: { t: number; hr: number }[] = [];
  private lastRecSample = 0;

  private hrSum = 0;
  private hrCount = 0;
  private hrMax = 0;
  private distanceM = 0;
  private kcal = 0;
  private zoneTimeSec: [number, number, number, number, number] = [0, 0, 0, 0, 0];

  // cached heavy metrics
  private dfa: DfaResult = { alpha1: null, artifactPct: 0, beats: 0, reliable: false };
  private hrv: HrvResult = { rmssd: null, sdnn: null, beats: 0 };
  private resp: RespirationResult = { brpm: null, confidence: 0 };
  private decoupling: DecouplingResult = {
    pct: null,
    firstHalf: null,
    secondHalf: null,
    ready: false,
    mode: "speed",
  };
  private lastHeavy = 0;
  private lastSeries = 0;
  private lastEff = 0;

  private series: SeriesPoint[] = [];

  constructor(profile: AthleteProfile) {
    this.profile = profile;
    this.detector = new IntervalDetector(profile);
  }

  setProfile(p: AthleteProfile) {
    this.profile = p;
    this.detector.setProfile(p);
  }

  start(now: number) {
    if (this.running) return;
    this.running = true;
    if (this.startT === 0) this.startT = now;
    this.lastTick = now;
  }

  stop() {
    this.running = false;
  }

  /** App-level pause: keep ingesting HR (live display) but freeze active time,
   *  the recorded trace, distance/kcal/zone — so they reflect work, not rest. */
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  isRunning() {
    return this.running;
  }
  isPaused() {
    return this.paused;
  }

  /** Begin heart-rate-recovery capture: anchor "now" as effort-end and seed the
   *  peak with the current HR. Call on pause / stop while the HRM is still on. */
  startRecovery(now: number) {
    this.recStartT = now;
    // Seed the peak only from a fresh, physiological reading (a 0/contact-loss
    // packet must not anchor the peak). lastRecSample = now → first curve sample
    // lands ~3 s in, never at t=0 (which would collide with the active end).
    this.recPeak = this.hr != null && this.hr > 30 && now - this.hrT <= 8000 ? this.hr : 0;
    this.recHr30 = null;
    this.recHr60 = null;
    this.recSamples = [];
    this.lastRecSample = now;
  }
  /** Abandon an in-progress recovery (e.g. the athlete resumed the workout). */
  clearRecovery() {
    this.recStartT = null;
    this.recPeak = 0;
    this.recHr30 = null;
    this.recHr60 = null;
    this.recSamples = [];
  }
  /** Finished recovery result, or null if none captured. */
  getRecovery(): RecoveryResult | null {
    if (this.recStartT == null || this.recPeak <= 0) return null;
    const hrr30 = this.recHr30 != null ? Math.max(0, this.recPeak - this.recHr30) : null;
    const hrr60 = this.recHr60 != null ? Math.max(0, this.recPeak - this.recHr60) : null;
    if (hrr30 == null && hrr60 == null) return null;
    return { peakHr: this.recPeak, hr30: this.recHr30, hr60: this.recHr60, hrr30, hrr60, samples: this.recSamples.slice() };
  }

  reset() {
    this.rr = [];
    this.effBuf = [];
    this.hr = null;
    this.hrT = 0;
    this.lastSpeed = null;
    this.cadence = null;
    this.cadenceT = 0;
    this.bodyTemp = null;
    this.bodyTempT = 0;
    this.startT = 0;
    this.lastTick = 0;
    this.running = false;
    this.paused = false;
    this.activeSec = 0;
    this.clearRecovery();
    this.hrSum = 0;
    this.hrCount = 0;
    this.hrMax = 0;
    this.distanceM = 0;
    this.kcal = 0;
    this.zoneTimeSec = [0, 0, 0, 0, 0];
    this.dfa = { alpha1: null, artifactPct: 0, beats: 0, reliable: false };
    this.hrv = { rmssd: null, sdnn: null, beats: 0 };
    this.resp = { brpm: null, confidence: 0 };
    this.decoupling = { pct: null, firstHalf: null, secondHalf: null, ready: false, mode: "speed" };
    this.lastHeavy = 0;
    this.lastSeries = 0;
    this.lastEff = 0;
    this.series = [];
    this.detector.reset();
  }

  ingestHR(s: HRSample) {
    this.hr = s.hr;
    this.hrT = s.t; // for staleness checks (recovery capture must ignore stale HR)
    // hrMax is tracked in tick() under the !paused guard (like hrAvg), so a
    // post-effort recovery spike during a pause can't pollute the session max.
    for (const r of s.rr) this.rr.push({ t: s.t, v: r });
  }

  ingestPace(s: PaceSample) {
    this.lastSpeed = s.speedMps;
  }

  /** Running cadence in steps/min (from a sim or an RSC sensor). */
  ingestCadence(t: number, spm: number) {
    if (Number.isFinite(spm) && spm >= 0) {
      this.cadence = spm;
      this.cadenceT = t;
    }
  }

  /** Core/body temperature in °C (from a sim or a thermometer sensor). */
  ingestTemp(t: number, c: number) {
    if (Number.isFinite(c) && c > 20 && c < 45) {
      this.bodyTemp = c;
      this.bodyTempT = t;
    }
  }

  /** Most recent value if it arrived within `maxAgeSec`, else null. */
  private fresh<T>(value: T | null, ts: number, now: number, maxAgeSec = 8): T | null {
    if (value === null) return null;
    return now - ts <= maxAgeSec * 1000 ? value : null;
  }

  /** Drop R-R beats older than the rolling window. */
  private pruneRR(now: number) {
    const cutoff = now - RR_WINDOW_SEC * 1000;
    let i = 0;
    while (i < this.rr.length && this.rr[i].t < cutoff) i++;
    if (i > 0) this.rr.splice(0, i);
  }

  private rrValues(): number[] {
    return this.rr.map((x) => x.v);
  }

  /** Advance accumulators and (throttled) heavy metrics. Call ~4 Hz. */
  tick(now: number): MetricsSnapshot {
    const bounds = zoneBounds(this.profile);

    if (this.running && this.lastTick > 0) {
      const dt = Math.min((now - this.lastTick) / 1000, 1.5); // clamp gaps
      if (dt > 0 && !this.paused) {
        // active recording time (excludes paused spans) — the basis for Strava
        this.activeSec += dt;
        // HR accumulators + zone time + max (all exclude paused rest)
        if (this.hr !== null) {
          this.hrSum += this.hr * dt;
          this.hrCount += dt;
          if (this.hr > this.hrMax) this.hrMax = this.hr;
          const z = zoneForHr(this.hr, bounds);
          this.zoneTimeSec[z - 1] += dt;
          this.kcal += this.kcalPerSec(this.hr) * dt;
        }
        // distance
        if (this.lastSpeed !== null) this.distanceM += this.lastSpeed * dt;
      }
    }
    this.lastTick = now;

    if (this.running) {
      this.detector.update(now, this.hr, this.lastSpeed);
      this.pruneRR(now);

      // Heart-rate recovery capture — runs whenever an effort-end anchor is set
      // (pause / post-stop), regardless of the paused flag. Only act on a FRESH,
      // physiological reading: a stale (dropout-frozen) or 0/contact-loss HR must
      // not latch hr30/hr60 or pollute the curve (it would fake a huge or zero
      // recovery). If HR is stale/bad at the mark, leave that HRR null.
      if (this.recStartT != null && this.hr !== null && this.hr > 30 && now - this.hrT <= 8000) {
        const el = now - this.recStartT;
        if (el < 10000 && this.hr > this.recPeak) this.recPeak = this.hr; // HR can crest a few s after stopping
        if (el >= 30000 && this.recHr30 === null) this.recHr30 = this.hr;
        if (el >= 60000 && this.recHr60 === null) this.recHr60 = this.hr;
        if (now - this.lastRecSample >= 3000 && el <= 65000) {
          this.lastRecSample = now;
          this.recSamples.push({ t: Math.round(el / 1000), hr: this.hr });
        }
      }

      // 1 Hz efficiency buffer (for decoupling) — active only, and stamped on the
      // ACTIVE timeline (not wall clock) so a pause doesn't inflate the span or
      // shift the first/second-half split that computeDecoupling derives from t.
      if (now - this.lastEff >= 1000 && this.hr !== null && !this.paused) {
        this.lastEff = now;
        this.effBuf.push({ t: this.startT + this.activeSec * 1000, hr: this.hr, speedMps: this.lastSpeed });
        if (this.effBuf.length > MAX_SERIES) this.effBuf.shift();
      }

      // heavy metrics (throttled)
      if (now - this.lastHeavy >= HEAVY_MS) {
        this.lastHeavy = now;
        const rrv = this.rrValues();
        this.dfa = computeDFA(rrv);
        this.hrv = computeHRV(rrv);
        this.resp = computeRespiration(rrv);
        this.decoupling = computeDecoupling(this.effBuf);
      }

      // 1 Hz series for charts — active only, so the saved trace excludes pauses
      // (which is what lets the .FIT/Strava report active time, not wall clock).
      if (now - this.lastSeries >= SERIES_MS && !this.paused) {
        this.lastSeries = now;
        this.series.push({
          t: now,
          hr: this.hr,
          alpha1: this.dfa.alpha1,
          speedMps: this.lastSpeed,
          brpm: this.resp.brpm,
          zone: this.hr !== null ? zoneForHr(this.hr, bounds) : null,
          cadence: this.fresh(this.cadence, this.cadenceT, now),
        });
        if (this.series.length > MAX_SERIES) this.series.shift();
      }
    }

    return this.snapshot(now, bounds);
  }

  private snapshot(now: number, bounds: MetricsSnapshot["zoneBounds"]): MetricsSnapshot {
    const hr = this.hr;
    const speed = this.lastSpeed;
    const paceSecPerKm = speed !== null && speed >= 0.45 ? 1000 / speed : null;
    return {
      t: now,
      elapsedSec: this.startT ? (now - this.startT) / 1000 : 0,
      activeSec: this.activeSec,
      recovery: this.recStartT != null
        ? {
            active: true,
            secsSince: Math.floor((now - this.recStartT) / 1000),
            peakHr: this.recPeak || null,
            hr30: this.recHr30,
            hr60: this.recHr60,
            hrr30: this.recHr30 != null ? Math.max(0, this.recPeak - this.recHr30) : null,
            hrr60: this.recHr60 != null ? Math.max(0, this.recPeak - this.recHr60) : null,
          }
        : { active: false, secsSince: 0, peakHr: null, hr30: null, hr60: null, hrr30: null, hrr60: null },
      hr,
      hrAvg: this.hrCount > 0 ? this.hrSum / this.hrCount : null,
      hrMax: this.hrMax || null,
      zone: hr !== null ? zoneForHr(hr, bounds) : null,
      zoneBounds: bounds,
      zoneTimeSec: this.zoneTimeSec,
      pctMax: hr !== null ? pctMax(hr, this.profile.maxHr) : null,
      hrv: this.hrv,
      dfa: this.dfa,
      respiration: this.resp,
      decoupling: this.decoupling,
      speedMps: speed,
      paceSecPerKm,
      distanceM: this.distanceM,
      cadence: this.fresh(this.cadence, this.cadenceT, now),
      bodyTempC: this.fresh(this.bodyTemp, this.bodyTempT, now),
      intervalState: this.detector.current,
      intervalCount: this.detector.intervalCount,
      stateElapsedSec: this.detector.stateElapsedSec(now),
      kcal: this.kcal,
    };
  }

  getSeries(): SeriesPoint[] {
    return this.series;
  }

  /** Keytel et al. (2005) HR→energy estimate, per second. */
  private kcalPerSec(hr: number): number {
    const { weightKg, age } = this.profile;
    // male coefficients; clamps keep it sane at rest
    const perMin =
      (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184;
    return Math.max(0, perMin) / 60;
  }
}
