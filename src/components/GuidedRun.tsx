import { AnimatePresence, motion } from "motion/react";
import type { AthleteProfile, WorkoutPlan } from "../types";
import type { RunnerState } from "../hooks/useWorkoutRunner";
import { RadialGauge } from "./Charts";
import { KIND_COLOR, KIND_LABEL, targetLabel } from "../lib/workout";
import { fmtClock } from "../lib/format";

export function GuidedRun({
  state,
  plan,
  profile,
  hr,
  sourceLive,
  simulated,
  paused,
  onStart,
  onPause,
  onConnect,
  onSimulate,
  onEdit,
}: {
  state: RunnerState;
  plan: WorkoutPlan;
  profile: AthleteProfile;
  hr: number | null;
  /** true when a HR source (sensor or simulator) is already streaming */
  sourceLive: boolean;
  /** true when the live source is the simulator (vs a real sensor) */
  simulated: boolean;
  paused: boolean;
  onStart: () => void;
  onPause: () => void;
  onConnect: () => void;
  onSimulate: () => void;
  onEdit: () => void;
}) {
  const iv = state.interval;
  const kindColor = iv ? KIND_COLOR[iv.kind] : "var(--color-volt)";

  return (
    <div className="card p-5 h-full flex flex-col relative overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="card-title">Guided Workout</span>
          {state.phase === "running" && (
            <span className="live-dot w-1.5 h-1.5 rounded-full bg-[var(--color-volt)]" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="mono text-[10px] text-[var(--color-ink-faint)] max-w-[140px] truncate">{plan.title}</span>
          <button onClick={onEdit} className="btn-ghost h-7 px-2.5 text-[11px]">Edit</button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {state.phase === "leadin" && (
          <motion.div key="leadin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 grid place-items-center">
            <div className="text-center">
              <div className="text-[11px] tracking-[0.3em] text-[var(--color-ink-faint)]">GET READY</div>
              <motion.div
                key={Math.ceil(state.remainingSec)}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="num text-[96px] leading-none mt-2"
                style={{ color: "var(--color-volt)" }}
              >
                {Math.ceil(state.remainingSec)}
              </motion.div>
              <div className="text-sm text-[var(--color-ink-dim)] mt-2">
                First up: <span className="text-[var(--color-ink)] font-semibold">{state.nextInterval?.name}</span>
              </div>
            </div>
          </motion.div>
        )}

        {state.phase === "running" && iv && (
          <motion.div key="running" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col relative">
            <div className="flex items-center gap-5 mt-1">
              <RadialGauge value={1 - state.fraction} min={0} max={1} size={150} thickness={11} color={kindColor}>
                <div className="text-center">
                  <div className="num text-3xl leading-none" style={{ color: "var(--color-ink)" }}>
                    {fmtClock(Math.ceil(state.remainingSec))}
                  </div>
                  <div className="text-[9px] tracking-[0.2em] text-[var(--color-ink-faint)] mt-1">REMAINING</div>
                </div>
              </RadialGauge>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ color: kindColor, background: "rgba(255,255,255,0.05)", border: `1px solid ${kindColor}` }}>
                    {KIND_LABEL[iv.kind]}
                  </span>
                  <span className="mono text-[10px] text-[var(--color-ink-faint)]">{state.currentIndex + 1}/{state.totalIntervals}</span>
                </div>
                <div className="font-[var(--font-display)] text-2xl font-semibold mt-1 truncate" style={{ color: "var(--color-ink)" }}>
                  {iv.name}
                </div>
                <div className="text-[12px] text-[var(--color-ink-dim)] mt-0.5">
                  Target: <span style={{ color: kindColor }}>{targetLabel(iv.target, profile)}</span>
                  {state.band && <span className="text-[var(--color-ink-faint)]"> · {state.band.low}–{state.band.high} bpm</span>}
                </div>
                {iv.notes && <div className="text-[11px] text-[var(--color-ink-faint)] mt-1 line-clamp-2">{iv.notes}</div>}
              </div>
            </div>

            <TargetMeter state={state} hr={hr} />

            <div className="mt-auto flex items-center justify-between gap-2 pt-3">
              <button
                onClick={onPause}
                className="btn-ghost h-8 px-3 text-[12px] shrink-0"
                style={paused ? { borderColor: "var(--color-volt)", color: "var(--color-volt)" } : undefined}
              >
                {paused ? "▶ Resume" : "❚❚ Pause"}
              </button>
              <div className="text-[11px] text-[var(--color-ink-faint)] flex-1 text-right truncate">
                {state.nextInterval ? <>Next: <span className="text-[var(--color-ink-dim)]">{state.nextInterval.name}</span></> : "Final interval"}
              </div>
              {state.adherencePct != null && (
                <div className="text-[11px] mono shrink-0">
                  <span style={{ color: state.adherencePct >= 70 ? "var(--color-mint)" : "var(--color-amber)" }}>{Math.round(state.adherencePct)}%</span>
                </div>
              )}
            </div>

            {paused && (
              <div className="absolute inset-0 grid place-items-center pointer-events-none" style={{ background: "rgba(7,8,10,0.55)", backdropFilter: "blur(1px)" }}>
                <div className="text-center">
                  <div className="num text-3xl font-bold" style={{ color: "var(--color-volt)" }}>PAUSED</div>
                  <div className="text-[11px] text-[var(--color-ink-dim)] mt-1">heart rate still recording{hr != null ? ` · ♥ ${hr}` : ""}</div>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {state.phase === "done" && (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 grid place-items-center">
            <div className="text-center">
              <div className="text-3xl">🏁</div>
              <div className="font-[var(--font-display)] text-2xl font-bold mt-2">Workout Complete</div>
              {state.adherencePct != null && (
                <div className="text-sm text-[var(--color-ink-dim)] mt-1">
                  You held target <span className="text-[var(--color-mint)] font-semibold">{Math.round(state.adherencePct)}%</span> of the time
                </div>
              )}
              <div className="text-[11px] text-[var(--color-ink-faint)] mt-3">Hit Stop to see your full summary.</div>
            </div>
          </motion.div>
        )}

        {state.phase === "idle" && (
          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 grid place-items-center text-center">
            <div>
              <div className="text-sm text-[var(--color-ink-dim)]">
                <span className="text-[var(--color-ink)] font-semibold">{plan.title}</span>
                <span className="mono text-[11px] text-[var(--color-ink-faint)]"> · {plan.intervals.length} intervals</span>
              </div>

              {sourceLive ? (
                <>
                  {hr != null && (
                    <div className="mono text-[11px] mt-1.5" style={{ color: simulated ? "var(--color-cyan)" : "var(--color-mint)" }}>
                      ♥ {hr} bpm — {simulated ? "simulated signal" : "sensor live"}
                    </div>
                  )}
                  <button onClick={onStart} className="btn-volt px-10 h-12 text-base mt-4">▶ START WORKOUT</button>
                  <div className="text-[11px] text-[var(--color-ink-faint)] mt-3 max-w-[300px] mx-auto leading-relaxed">
                    Begins the lead-in countdown and voice coaching.
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[12px] text-[var(--color-ink-faint)] mt-2 mb-4">Choose your heart-rate source to begin.</div>
                  <div className="flex items-center justify-center gap-2">
                    <button onClick={onConnect} className="btn-volt px-5 h-11 text-sm">Connect Sensor</button>
                    <button onClick={onSimulate} className="btn-ghost px-5 h-11 text-sm">Use Simulator</button>
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-faint)] mt-3 max-w-[300px] mx-auto leading-relaxed">
                    A connected strap is always used for real metrics; the simulator is only for trying it out.
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TargetMeter({ state, hr }: { state: RunnerState; hr: number | null }) {
  if (!state.band) {
    return (
      <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--color-line)] px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">
        No HR target on this interval — go by feel.
      </div>
    );
  }
  const { low, high } = state.band;
  const status = state.hrStatus;
  const map = {
    in: { c: "var(--color-mint)", label: "ON TARGET", sub: "hold it here" },
    under: { c: "var(--color-cyan)", label: "BELOW TARGET", sub: "↑ push harder" },
    over: { c: "var(--color-amber)", label: "ABOVE TARGET", sub: "↓ ease off" },
    none: { c: "var(--color-ink-faint)", label: "—", sub: "" },
  }[status];

  // position of hr within a padded band window
  const span = high - low;
  const lo = low - span * 0.6;
  const hi = high + span * 0.6;
  const pos = hr != null ? Math.max(0, Math.min(1, (hr - lo) / (hi - lo))) : 0.5;
  const bandL = (low - lo) / (hi - lo);
  const bandR = (high - lo) / (hi - lo);

  return (
    <div className="mt-3 rounded-xl bg-white/[0.03] border border-[var(--color-line)] px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="num text-2xl" style={{ color: map.c }}>{hr ?? "—"}</span>
          <span className="text-[10px] text-[var(--color-ink-faint)]">bpm</span>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-semibold tracking-wide" style={{ color: map.c }}>{map.label}</div>
          <div className="text-[10px] text-[var(--color-ink-faint)]">{map.sub}</div>
        </div>
      </div>
      <div className="relative h-3 rounded-full bg-white/[0.05] overflow-hidden">
        {/* target band */}
        <div className="absolute top-0 bottom-0 rounded-full" style={{ left: `${bandL * 100}%`, right: `${(1 - bandR) * 100}%`, background: "rgba(61,255,181,0.22)", borderLeft: "1px solid var(--color-mint)", borderRight: "1px solid var(--color-mint)" }} />
        {/* hr marker */}
        <motion.div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-5 rounded-full" style={{ background: map.c, boxShadow: `0 0 8px ${map.c}` }} animate={{ left: `calc(${pos * 100}% - 3px)` }} transition={{ type: "spring", stiffness: 120, damping: 18 }} />
      </div>
      <div className="flex justify-between text-[9px] mono text-[var(--color-ink-faint)] mt-1">
        <span>{low}</span>
        <span>target</span>
        <span>{high}</span>
      </div>
    </div>
  );
}
