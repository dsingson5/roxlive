import { motion } from "motion/react";
import type { AthleteProfile, WorkoutPlan } from "../types";
import type { RunnerState } from "../hooks/useWorkoutRunner";
import { KIND_COLOR, planDurationSec, targetLabel } from "../lib/workout";
import { fmtClock } from "../lib/format";

export function WorkoutRail({
  plan,
  state,
  profile,
}: {
  plan: WorkoutPlan;
  state: RunnerState;
  profile: AthleteProfile;
}) {
  const total = planDurationSec(plan);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="card-title">{plan.title} · {plan.intervals.length} intervals</div>
        <div className="text-[10px] mono text-[var(--color-ink-faint)]">{fmtClock(total)} total</div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
        {plan.intervals.map((iv, i) => {
          const active = i === state.currentIndex && state.phase === "running";
          const done = state.phase === "done" || i < state.currentIndex;
          const color = KIND_COLOR[iv.kind];
          const adh = state.perInterval.find((p) => p.index === i);
          const adhPct = adh && adh.totalSec > 1 ? (adh.inTargetSec / adh.totalSec) * 100 : null;
          // width proportional to duration (clamped)
          const w = Math.max(54, Math.min(150, 40 + (iv.durationSec / total) * 700));
          return (
            <div
              key={iv.id}
              className="shrink-0 rounded-xl px-2.5 py-2 relative"
              style={{
                width: w,
                background: active ? "rgba(216,255,58,0.08)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${active ? color : "var(--color-line)"}`,
                opacity: done && !active ? 0.6 : 1,
              }}
            >
              {active && (
                <motion.span layoutId="wrail-cursor" className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
              )}
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                <span className="num text-[11px] truncate" style={{ color: "var(--color-ink)" }}>{iv.name}</span>
              </div>
              <div className="mono text-[9px] text-[var(--color-ink-faint)] mt-0.5">{fmtClock(iv.durationSec)} · {targetLabel(iv.target, profile)}</div>
              {adhPct != null ? (
                <div className="mono text-[9px] mt-0.5" style={{ color: adhPct >= 70 ? "var(--color-mint)" : "var(--color-amber)" }}>
                  {Math.round(adhPct)}% in zone
                </div>
              ) : (
                <div className="h-[12px]" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
