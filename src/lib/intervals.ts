/**
 * Work / rest interval detection — a core PDF metric for HYROX-style
 * intermittent sessions. A debounced state machine driven by HR (relative to
 * reserve) and, when present, speed. Hysteresis + minimum dwell prevents the
 * flicker you get from raw thresholding.
 */

import type { AthleteProfile, IntervalState } from "../types";

export interface IntervalConfig {
  /** %HRR above which we consider "work" (enter) */
  enterPct: number;
  /** %HRR below which we drop to "rest" (exit) */
  exitPct: number;
  /** speed (m/s) that forces "work" regardless of HR */
  workSpeed: number;
  /** minimum seconds in a state before a transition is allowed */
  minDwellSec: number;
}

export const DEFAULT_INTERVAL_CONFIG: IntervalConfig = {
  enterPct: 80,
  exitPct: 68,
  workSpeed: 1.2,
  minDwellSec: 8,
};

export class IntervalDetector {
  private state: IntervalState = "idle";
  private stateStart = 0;
  private count = 0;

  constructor(
    private profile: AthleteProfile,
    private cfg: IntervalConfig = DEFAULT_INTERVAL_CONFIG
  ) {}

  setProfile(p: AthleteProfile) {
    this.profile = p;
  }

  reset() {
    this.state = "idle";
    this.stateStart = 0;
    this.count = 0;
  }

  /** Feed one sample. Returns the (possibly unchanged) state. */
  update(t: number, hr: number | null, speedMps: number | null): IntervalState {
    if (this.stateStart === 0) this.stateStart = t;
    if (hr === null) return this.state;

    const range = this.profile.maxHr - this.profile.restHr;
    const pctHrr = range > 0 ? ((hr - this.profile.restHr) / range) * 100 : 0;
    const moving = speedMps !== null && speedMps >= this.cfg.workSpeed;

    const dwell = (t - this.stateStart) / 1000;
    const wantWork = pctHrr >= this.cfg.enterPct || moving;
    const wantRest = pctHrr <= this.cfg.exitPct && !moving;

    if (this.state === "idle") {
      if (wantWork) this.enter("work", t);
      else if (dwell > 3) this.enter("rest", t); // settle to rest after a few s
    } else if (this.state === "rest") {
      if (wantWork && dwell >= this.cfg.minDwellSec) {
        this.enter("work", t);
        this.count++;
      }
    } else if (this.state === "work") {
      if (wantRest && dwell >= this.cfg.minDwellSec) this.enter("rest", t);
    }
    return this.state;
  }

  private enter(s: IntervalState, t: number) {
    this.state = s;
    this.stateStart = t;
  }

  get current(): IntervalState {
    return this.state;
  }
  get intervalCount(): number {
    return this.count;
  }
  stateElapsedSec(now: number): number {
    return this.stateStart ? (now - this.stateStart) / 1000 : 0;
  }
}
