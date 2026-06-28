/* Self-test for the ported MBP analytics. Run: npx tsx src/lib/analytics/selftest.ts */
import type { SeriesPoint, SessionSummary } from "../../types";
import { analyzeSession } from "./index";
import { trainingLoad, computePmc, dailyTssDense } from "./trainingLoad";
import { pwlfOneKnot, autoWarmupEnd } from "./durability";
import { classifyDecoupling, efficiencyFactor, decoupling } from "./efficiency";
import { mbpFamily } from "./util";
import { refuel } from "./refuel";
import { strideFatigue } from "./physiology";

let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) fail++;
};

const prof = { maxHr: 185, restHr: 48, weightKg: 74, sex: "male" as const };

// 1) hrTSS known answer: 1 hour at LTHR (~0.88·max = 163) → hrTSS ≈ 100.
{
  const pts: SeriesPoint[] = Array.from({ length: 3600 }, (_, i) => ({ t: i * 1000, hr: 163, alpha1: null, speedMps: null, brpm: null, zone: null, cadence: null }));
  const tl = trainingLoad(pts, prof);
  ok("hrTSS ≈ 100 for 1h @ LTHR", !!tl && tl.tss > 95 && tl.tss < 106, tl ? `tss=${tl.tss} trimp=${tl.trimp} lthr=${tl.lthr}` : "null");
  ok("Edwards TRIMP > 0", !!tl && tl.trimpEdwards > 0, tl ? `${tl.trimpEdwards}` : "");
}

// 2) PMC convergence: constant 100 TSS/day → CTL=ATL=100, TSB=0.
{
  const daily = Array.from({ length: 60 }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, tss: 100 }));
  const pmc = computePmc(daily);
  const last = pmc[pmc.length - 1];
  ok("PMC constant load → CTL≈100", Math.abs(last.ctl - 100) < 1, `ctl=${last.ctl}`);
  ok("PMC constant load → TSB≈0", Math.abs(last.tsb) < 1, `tsb=${last.tsb}`);
}

// 3) PMC ramp: 30 rest days then 30×100 → ATL > CTL (fresh→fatigued).
{
  const daily = [
    ...Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, tss: 0 })),
    ...Array.from({ length: 30 }, (_, i) => ({ date: `e${i}`, tss: 100 })),
  ];
  const pmc = computePmc(daily);
  const last = pmc[pmc.length - 1];
  ok("PMC ramp → ATL>CTL (fatigue)", last.atl > last.ctl && last.tsb < 0, `ctl=${last.ctl} atl=${last.atl} tsb=${last.tsb}`);
}

// 4) dailyTssDense gap-fills rest days with 0.
{
  const dense = dailyTssDense([{ dateIso: "2026-06-01", tss: 80 }, { dateIso: "2026-06-04", tss: 50 }]);
  ok("dailyTssDense fills the gap (4 days)", dense.length === 4 && dense[1].tss === 0 && dense[2].tss === 0, `len=${dense.length}`);
}

// 5) pwlf recovers a 2-slope break.
{
  const n = 1200;
  const x = Array.from({ length: n }, (_, i) => i);
  const y = x.map((xi) => (xi < 600 ? 100 - 0.01 * xi : 100 - 0.01 * 600 - 0.05 * (xi - 600)));
  const fit = pwlfOneKnot(x, y, 300);
  ok("pwlf finds knot ≈ 600", !!fit && Math.abs(fit.x0 - 600) < 60, fit ? `x0=${fit.x0.toFixed(0)}` : "null");
  ok("pwlf slope2 steeper (more negative)", !!fit && fit.slope2 < fit.slope1, fit ? `s1=${fit.slope1.toFixed(4)} s2=${fit.slope2.toFixed(4)}` : "");
}

// 6) Full analyzeSession on a synthetic 40-min run with a late slowdown.
{
  const N = 2400;
  const pts: SeriesPoint[] = Array.from({ length: N }, (_, i): SeriesPoint => {
    const ramp = Math.min(1, i / 120);
    const hr = 120 + 40 * ramp + (i > 1600 ? (i - 1600) * 0.01 : 0); // creep late
    const speed = i < 1600 ? 3.4 : 3.4 - (i - 1600) * 0.0004; // slow down late
    return { t: i * 1000, hr: Math.round(hr), alpha1: +(0.9 - 0.0002 * i).toFixed(3), speedMps: +speed.toFixed(2), brpm: +(26 + 6 * ramp).toFixed(1), zone: 3, cadence: 88 };
  });
  const summary: SessionSummary = {
    id: "t", startedAt: 0, endedAt: N * 1000, durationSec: N, activeSec: N, mode: "free", modality: "run",
    avgHr: 158, maxHr: 178, distanceM: 8000, kcal: 600, zoneTimeSec: [60, 300, 900, 900, 240], decouplingPct: 6.1,
    minAlpha1: 0.45, avgBrpm: 31, intervalCount: 0, segments: [], series: pts,
  };
  const a = analyzeSession(summary, pts, prof);
  ok("analyze: tss present", a.tss != null && a.tss > 0, `tss=${a.tss}`);
  ok("analyze: EF present", a.ef != null && a.ef > 0, `ef=${a.ef} (${a.efMode})`);
  ok("analyze: cardiac cost present", a.cardiacCostBpkm != null && a.cardiacCostBpkm > 0, `${a.cardiacCostBpkm} bpkm`);
  ok("analyze: intensity zone", !!a.intensity?.zone, a.intensity?.zone);
  ok("analyze: decoupling class (6.1% run → Adapting)", !!a.decouplingClass && /adapting/i.test(a.decouplingClass), a.decouplingClass);
  ok("analyze: decoupling high-drift branch", /lessen/i.test(classifyDecoupling(9, "run")), classifyDecoupling(9, "run"));
  ok("analyze: decoupling negative-run branch", /artifact/i.test(classifyDecoupling(-2, "run")), classifyDecoupling(-2, "run"));
  ok("analyze: splits + CV", a.paceCvPct != null, `cv=${a.paceCvPct}% fastest=${a.fastestKm} slowest=${a.slowestKm}`);
  ok("analyze: stride", a.strideM != null && a.strideM > 0.5 && a.strideM < 2.5, `${a.strideM} m`);
  ok("analyze: refuel", !!a.refuel && a.refuel.carbGHi > 0, a.refuel ? `${a.refuel.carbGLo}-${a.refuel.carbGHi} g` : "");
  ok("analyze: warmup end sane", a.warmupEndSec != null && a.warmupEndSec >= 60 && a.warmupEndSec < N, `${a.warmupEndSec}s`);
  ok("analyze: EF decay computed", a.efDecayPctPerHr != null, `${a.efDecayPctPerHr}%/h r2=${a.efDecayR2}`);
  console.log("   durability:", a.durabilityMin == null ? "not flagged" : `${a.durabilityMin}min (${a.durabilityConf})`);
}

// 7) Modality normalization (review fix: cycling/erg no longer fall to RUN).
{
  ok("mbpFamily bike_erg → bike", mbpFamily("bike_erg") === "bike");
  ok("mbpFamily indoor_bike → bike", mbpFamily("indoor_bike") === "bike");
  ok("mbpFamily row_erg → erg", mbpFamily("row_erg") === "erg");
  ok("mbpFamily run → run", mbpFamily("run") === "run");
  ok("bike decoupling uses 3/5 bands", /watts/.test(classifyDecoupling(4, "bike")) && /adapting/i.test(classifyDecoupling(4, "bike")), classifyDecoupling(4, "bike"));
  ok("bike 6% → high drift (>5)", /lessen/i.test(classifyDecoupling(6, "bike")), classifyDecoupling(6, "bike"));
  const rRun = refuel(60, "z3", "run");
  const rBike = refuel(60, "z3", "bike");
  ok("bike carb table < run carb table", !!rRun && !!rBike && rBike.carbGHi < rRun.carbGHi, `bike ${rBike?.carbGHi} < run ${rRun?.carbGHi}`);
}

// 8) EF mixed/HYROX: run-only output ÷ run-only HR (not whole-session HR).
{
  const make = (n: number, hr: number, sp: number): SeriesPoint => ({ t: 0, hr, alpha1: null, speedMps: sp, brpm: null, zone: null, cadence: null });
  const pts: SeriesPoint[] = [];
  for (let i = 0; i < 300; i++) pts.push({ ...make(i, 160, 3), t: i * 1000 }); // run 5 min
  for (let i = 0; i < 300; i++) pts.push({ ...make(i, 150, 0), t: (300 + i) * 1000 }); // station 5 min
  const ef = efficiencyFactor(pts);
  // run-true: 3 m/s = 180 m/min ÷ 160 = 1.125 (NOT 180/155 ≈ 1.16)
  ok("EF mixed uses moving-only HR (≈1.125)", !!ef && ef.mode === "speed" && Math.abs(ef.ef - 1.125) < 0.02, ef ? `ef=${ef.ef} hr=${ef.avgHr}` : "null");
}

// 9) Stride: single-leg cadence (85) is doubled to ~170 (review fix).
{
  const pts: SeriesPoint[] = Array.from({ length: 120 }, (_, i): SeriesPoint => ({ t: i * 1000, hr: 150, alpha1: null, speedMps: 3.0, brpm: null, zone: null, cadence: 85 }));
  const st = strideFatigue(pts);
  ok("stride doubles single-leg cadence (~170 spm, ~1.06 m)", !!st && st.avgCadenceSpm > 160 && st.avgStrideM < 1.5, st ? `${st.avgStrideM}m @ ${st.avgCadenceSpm}spm` : "null");
}

// 7) MBP-style decoupling: warm-up excluded, positive drift when EF declines.
{
  const N = 1800; // 30 min @ 1 Hz
  // constant speed; HR drifts up 150→162 → EF declines → positive decoupling
  const pts: SeriesPoint[] = Array.from({ length: N }, (_, i): SeriesPoint => ({ t: i * 1000, hr: Math.round(150 + 12 * (i / N)), alpha1: null, speedMps: 3.3, brpm: null, zone: null, cadence: null }));
  const dec = decoupling(pts, 0);
  ok("decoupling positive when EF declines", !!dec && dec.pct > 0 && dec.method === "EF", dec ? `${dec.pct}% (${dec.method})` : "null");
  // a fast-then-steady warm-up: trimming the first 5 min changes the number
  const pts2: SeriesPoint[] = Array.from({ length: N }, (_, i): SeriesPoint => ({ t: i * 1000, hr: i < 300 ? 120 : Math.round(150 + 12 * (i / N)), alpha1: null, speedMps: 3.3, brpm: null, zone: null, cadence: null }));
  const incl = decoupling(pts2, 0);
  const excl = decoupling(pts2, 300);
  ok("decoupling warm-up trim changes result", !!incl && !!excl && Math.abs(incl.pct - excl.pct) > 0.3, `incl ${incl?.pct}% vs excl ${excl?.pct}%`);
  // HR-only mode (no speed) → cardiac drift
  const ptsHr: SeriesPoint[] = Array.from({ length: N }, (_, i): SeriesPoint => ({ t: i * 1000, hr: Math.round(150 + 12 * (i / N)), alpha1: null, speedMps: null, brpm: null, zone: null, cadence: null }));
  const decHr = decoupling(ptsHr, 0);
  ok("decoupling HR-only mode", !!decHr && decHr.method === "HR drift" && decHr.pct > 0, decHr ? `${decHr.pct}% (${decHr.method})` : "null");
}

// 8) Long-session downsample must NOT collapse the timeline (dts gap-clamp fix):
// a 3 h run downsampled at the real stride should give ~the same warm-up + decoupling
// as the full 1 Hz series (regression for the >2h47m dts() 10 s-clamp bug).
{
  const N = 10800; // 3 h @ 1 Hz
  const full: SeriesPoint[] = Array.from({ length: N }, (_, i): SeriesPoint => ({ t: i * 1000, hr: i < 600 ? 125 : Math.round(150 + 10 * (i / N)), alpha1: null, speedMps: 3.2, brpm: null, zone: null, cadence: null }));
  const stride = Math.max(5, Math.ceil(full.length / 1000)); // = 11 for 3 h — same as buildSummary
  const ds = full.filter((_, i) => i % stride === 0);
  const wFull = autoWarmupEnd(full);
  const wDs = autoWarmupEnd(ds);
  const decFull = decoupling(full, wFull);
  const decDs = decoupling(ds, wDs);
  ok("3h downsample: warm-up not collapsed", Math.abs(wFull - wDs) <= Math.max(120, wFull * 0.3), `full ${wFull}s vs ds ${wDs}s (stride ${stride}s)`);
  ok("3h downsample: decoupling matches full", !!decFull && !!decDs && Math.abs(decFull.pct - decDs.pct) <= 1.5, `full ${decFull?.pct}% vs ds ${decDs?.pct}%`);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
const g = globalThis as { process?: { exit?: (n: number) => void } };
if (fail) g.process?.exit?.(1);
