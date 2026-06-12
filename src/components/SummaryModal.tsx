import { AnimatePresence, motion } from "motion/react";
import type { SeriesPoint, SessionSummary } from "../types";
import { Sparkline } from "./Charts";
import { ZONE_DEFS } from "../lib/zones";
import { downloadFit } from "../lib/fit";
import { fmtClock, fmtDist, fmtNum, fmtSigned } from "../lib/format";

export function SummaryModal({
  summary,
  fullSeries,
  onClose,
}: {
  summary: SessionSummary | null;
  /** full-resolution (1 Hz) series for the .FIT export */
  fullSeries: SeriesPoint[];
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {summary && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            className="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="card pointer-events-auto w-[min(620px,96vw)] max-h-[90vh] overflow-y-auto p-6"
              initial={{ scale: 0.94, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.94, y: 16 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
            >
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-[var(--font-display)] text-2xl font-bold">Session Complete</h2>
                <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
              </div>
              <div className="mono text-[11px] text-[var(--color-ink-faint)] mb-5">
                {summary.mode === "hyrox" ? "HYROX simulation" : summary.mode === "workout" ? summary.planTitle ?? "Guided workout" : "Free analyzer"} · {fmtClock(summary.durationSec)}
              </div>

              {summary.mode === "workout" && summary.adherencePct != null && (
                <div className="card p-4 mb-4 flex items-center justify-between" style={{ borderColor: summary.adherencePct >= 70 ? "rgba(61,255,181,0.35)" : "rgba(255,176,46,0.35)" }}>
                  <div>
                    <div className="card-title mb-1">Target Adherence</div>
                    <div className="text-[11px] text-[var(--color-ink-dim)]">Time spent inside your prescribed HR targets</div>
                  </div>
                  <div className="num text-4xl" style={{ color: summary.adherencePct >= 70 ? "var(--color-mint)" : "var(--color-amber)" }}>
                    {Math.round(summary.adherencePct)}<span className="text-lg">%</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                <Stat label="Avg HR" value={fmtNum(summary.avgHr)} unit="bpm" />
                <Stat label="Max HR" value={fmtNum(summary.maxHr)} unit="bpm" />
                <Stat label="Distance" value={fmtDist(summary.distanceM)} />
                <Stat label="Energy" value={fmtNum(summary.kcal)} unit="kcal" />
                <Stat label="Min α1" value={summary.minAlpha1 != null ? summary.minAlpha1.toFixed(2) : "—"} accent="var(--color-cyan)" />
                <Stat label="Decoupling" value={summary.decouplingPct != null ? fmtSigned(summary.decouplingPct, 1) + "%" : "—"} accent="var(--color-mint)" />
                <Stat label="Avg Breath" value={fmtNum(summary.avgBrpm)} unit="br/m" />
                <Stat label="Reps" value={String(summary.intervalCount)} />
              </div>

              {/* HR trace */}
              <div className="card p-3 mb-4">
                <div className="card-title mb-1">HR Trace</div>
                <Sparkline data={summary.series.map((p) => p.hr)} color="var(--color-volt)" width={560} height={64} />
              </div>

              {/* zones */}
              <div className="card-title mb-2">Time in Zone</div>
              <div className="flex h-4 rounded-full overflow-hidden mb-1">
                {ZONE_DEFS.map((z, i) => {
                  const total = summary.zoneTimeSec.reduce((a, b) => a + b, 0) || 1;
                  const pct = (summary.zoneTimeSec[i] / total) * 100;
                  return <div key={z.z} style={{ width: `${pct}%`, background: z.color }} title={`Z${z.z} ${fmtClock(summary.zoneTimeSec[i])}`} />;
                })}
              </div>
              <div className="flex justify-between text-[10px] mono text-[var(--color-ink-faint)]">
                {ZONE_DEFS.map((z, i) => (
                  <span key={z.z} style={{ color: z.color }}>Z{z.z} {fmtClock(summary.zoneTimeSec[i])}</span>
                ))}
              </div>

              {summary.segments.length > 0 && (
                <>
                  <div className="card-title mt-5 mb-2">Splits</div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
                    {summary.segments.map((s) => (
                      <div key={s.index} className="flex justify-between border-b border-[var(--color-line)] py-1">
                        <span className="text-[var(--color-ink-dim)]">{s.label}</span>
                        <span className="mono" style={{ color: s.kind === "run" ? "var(--color-cyan)" : "var(--color-ink)" }}>
                          {s.splitSec != null ? fmtClock(s.splitSec) : "—"}{s.avgHr ? ` · ${Math.round(s.avgHr)}bpm` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="flex gap-2 mt-6">
                <button
                  onClick={() => downloadFit(summary, fullSeries.length ? fullSeries : summary.series)}
                  className="btn-ghost flex-1 h-11 text-sm"
                  title="Garmin FIT activity — import into Garmin Connect, Strava, TrainingPeaks…"
                >
                  ⬇ Export .FIT
                </button>
                <button onClick={onClose} className="btn-volt flex-1 h-11 text-sm">Done</button>
              </div>
              <p className="text-[10px] text-[var(--color-ink-faint)] mt-2 text-center">
                .FIT includes 1 Hz heart rate, laps per interval, and session totals — uploads to Strava, Garmin Connect &amp; co.
              </p>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-[var(--color-line)] p-3">
      <div className="num text-2xl" style={{ color: accent ?? "var(--color-ink)" }}>
        {value}
        {unit && <span className="text-xs text-[var(--color-ink-faint)] ml-1">{unit}</span>}
      </div>
      <div className="text-[10px] tracking-[0.12em] text-[var(--color-ink-faint)] mt-1 uppercase">{label}</div>
    </div>
  );
}
