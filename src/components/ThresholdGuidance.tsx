/**
 * Threshold-run reminder + buy-out card. Shows the "pace is the dose" principle on
 * every supra-MLSS / sub-threshold run, plus the station buy-out menu (supra) or the
 * keep-it-clean appendix (sub). Detected from the workout title.
 */
import { classifyThresholdRun, PACE_IS_THE_DOSE, SUPRA_BUYOUT, SUB_BUYOUT } from "../lib/thresholdCoach";

export function ThresholdGuidance({ title }: { title: string | undefined | null }) {
  const kind = classifyThresholdRun(title);
  if (!kind) return null;

  return (
    <div className="card p-4 mb-3" style={{ borderColor: "rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.06)" }}>
      <div className="text-[13px] leading-relaxed text-[var(--color-ink)]">
        <span className="font-bold">🎯 The pace is the dose.</span>{" "}
        <span className="text-[var(--color-ink-dim)]">{PACE_IS_THE_DOSE.replace("The pace is the dose. ", "")}</span>
      </div>

      <details className="mt-3 group">
        <summary className="cursor-pointer text-[12px] font-semibold text-[var(--color-volt)] select-none">
          {kind === "supra" ? "Station buy-out menu ▾" : "Sub-threshold buy-out (keep it clean) ▾"}
        </summary>
        {kind === "supra" ? (
          <div className="mt-2 text-[12px] text-[var(--color-ink-dim)] space-y-2">
            <div>{SUPRA_BUYOUT.structure}</div>
            <div className="rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-line)] overflow-hidden">
              {SUPRA_BUYOUT.menu.map((b, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 px-3 py-1.5 border-b border-[var(--color-line)] last:border-0">
                  <div>
                    <span className="font-semibold text-[var(--color-ink)]">{b.name}</span>{" "}
                    <span className="text-[var(--color-ink-faint)]">— {b.detail}</span>
                  </div>
                  <span className="text-[10px] text-[var(--color-ink-faint)] whitespace-nowrap">tibia: {b.tibial}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-[var(--color-ink-faint)]">{SUPRA_BUYOUT.bsr}</div>
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-[var(--color-ink-dim)] space-y-2">
            <div className="text-[var(--color-ink)]">{SUB_BUYOUT.rule}</div>
            <div>{SUB_BUYOUT.optional}</div>
            <div className="text-[11px] text-[var(--color-ink-faint)]">{SUB_BUYOUT.avoid}</div>
          </div>
        )}
      </details>
    </div>
  );
}
