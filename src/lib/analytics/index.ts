/**
 * Post-run analytics orchestrator — assembles a {@link PostRunAnalytics} from a
 * finished session's series + the athlete profile, by calling the ported MBP-beta
 * algorithms. Pure + dependency-free so it runs at finalize AND lazily in the UI.
 *
 * PMC (CTL/ATL/TSB) is cross-session, so it lives in trainingLoad.ts and is wired
 * separately over the history (see App). Everything here is per-session.
 */

import type { PostRunAnalytics, SeriesPoint, SessionSummary } from "../../types";
import type { Prof } from "./util";
import { dominantZone, mbpFamily } from "./util";
import { trainingLoad } from "./trainingLoad";
import { efficiencyFactor, cardiacCost, classifyDecoupling, intensityContext } from "./efficiency";
import { splitAnalysis } from "./splits";
import { refuel } from "./refuel";
import { lt1Polarization, respiratory, strideFatigue } from "./physiology";
import { pointOfNoReturn, efDegradationRate, autoWarmupEnd } from "./durability";

export type { Prof } from "./util";
export { COACH_GUIDANCE } from "./coachFacts";
export { trainingLoad, defaultLthr, computePmc, dailyTssDense, formLabel } from "./trainingLoad";
export type { PmcPoint } from "./trainingLoad";

/** Compute the full per-session analytics bundle. Best-effort: each block is
 *  independent and simply omitted if its inputs are absent. */
export function analyzeSession(summary: SessionSummary, series: SeriesPoint[], prof: Prof): PostRunAnalytics {
  const a: PostRunAnalytics = {};
  const pts = (series || []).filter((p) => p && Number.isFinite(p.t));
  const mode = summary.modality && summary.modality !== "mixed" ? summary.modality : summary.mode;
  const fam = mbpFamily(String(mode)); // run | bike | erg — for decoupling bands + carb table
  const minutes = (summary.activeSec ?? summary.durationSec ?? 0) / 60;

  try {
    const tl = trainingLoad(pts, prof);
    if (tl) {
      a.tss = tl.tss;
      a.trimp = tl.trimp;
      a.trimpEdwards = tl.trimpEdwards;
      a.lthr = tl.lthr;
    }
  } catch { /* skip */ }

  try {
    const ef = efficiencyFactor(pts);
    if (ef) {
      a.ef = ef.ef;
      a.efMode = ef.mode;
    }
  } catch { /* skip */ }

  try {
    const cc = cardiacCost(pts);
    if (cc) {
      a.cardiacCostBpkm = cc.beatsPerKm;
      a.cardiacRisePct = cc.risePct;
    }
  } catch { /* skip */ }

  try {
    if (summary.avgHr != null) {
      const it = intensityContext(summary.avgHr, prof);
      if (it) a.intensity = it;
    }
  } catch { /* skip */ }

  try {
    if (summary.decouplingPct != null) a.decouplingClass = classifyDecoupling(summary.decouplingPct, fam);
  } catch { /* skip */ }

  try {
    const lt1 = lt1Polarization(pts, prof);
    if (lt1) {
      a.lt1Hr = lt1.lt1Hr;
      a.lt1PctBelow = lt1.pctBelow;
      a.lt1Source = lt1.source;
    }
  } catch { /* skip */ }

  try {
    const r = respiratory(pts);
    if (r) {
      a.respDriftPct = r.driftPct;
      a.respRrHrRatio = r.rrHrRatio;
    }
  } catch { /* skip */ }

  try {
    const st = strideFatigue(pts);
    if (st) {
      a.strideM = st.avgStrideM;
      a.strideChangePct = st.changePct;
    }
  } catch { /* skip */ }

  // Run-flavoured extras (need distance/speed): splits + durability + warm-up.
  const hasSpeed = pts.some((p) => p.speedMps != null && (p.speedMps as number) > 0);
  if (hasSpeed) {
    try {
      const sp = splitAnalysis(pts);
      if (sp) {
        a.paceCvPct = sp.paceCvPct;
        a.negativeSplit = sp.isNegativeSplit;
        a.fastestKm = sp.fastestKm;
        a.slowestKm = sp.slowestKm;
      }
    } catch { /* skip */ }
    try {
      const ponr = pointOfNoReturn(pts);
      if (ponr) {
        a.durabilityMin = +(ponr.breakSec / 60).toFixed(1);
        a.durabilityConf = ponr.confidence;
      }
    } catch { /* skip */ }
  }

  try {
    const deg = efDegradationRate(pts);
    if (deg) {
      a.efDecayPctPerHr = deg.pctPerHr;
      a.efDecayR2 = deg.r2;
    }
  } catch { /* skip */ }

  try {
    a.warmupEndSec = autoWarmupEnd(pts);
  } catch { /* skip */ }

  try {
    const rf = refuel(minutes, dominantZone(summary.zoneTimeSec || [0, 0, 0, 0, 0]), fam);
    if (rf) a.refuel = rf;
  } catch { /* skip */ }

  return a;
}
