import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { WorkoutPlan } from "../types";
import { fetchCalendarWorkouts, incomingToPlan, type CalendarEntry } from "../lib/calendarImport";

/**
 * "From your calendar" picker. Fetches the signed-in athlete's live training
 * calendar from the hub (same origin) and lists every programmed day. Tapping a
 * day converts its prescription into a runnable plan and hands it to RoxLive.
 * Because it reads the live page, workouts the coach adds later show up here with
 * no app change. Falls back to an empty state (offline / no calendar).
 */
export function CalendarPicker({
  open,
  pageFile,
  userName,
  onClose,
  onPick,
}: {
  open: boolean;
  pageFile: string | null;
  userName: string;
  onClose: () => void;
  onPick: (plan: WorkoutPlan) => void;
}) {
  const [entries, setEntries] = useState<CalendarEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open || !pageFile) return;
    let live = true;
    const ctrl = new AbortController();
    setEntries(null);
    setError(false);
    fetchCalendarWorkouts(pageFile, ctrl.signal)
      .then((list) => { if (live) { setEntries(list); setError(list.length === 0); } })
      .catch(() => { if (live) { setEntries([]); setError(true); } });
    return () => { live = false; ctrl.abort(); };
  }, [open, pageFile]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-4 pointer-events-none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="card pointer-events-auto w-[min(640px,97vw)] max-h-[90vh] overflow-y-auto p-5 sm:p-6"
              initial={{ scale: 0.95, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 16 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
            >
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-[var(--font-display)] text-2xl font-bold">Your calendar</h2>
                <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
              </div>
              <p className="text-[12px] text-[var(--color-ink-dim)] mb-4">
                Tap a day to load it{userName ? `, ${userName}` : ""} — it arrives armed and ready to START. You can tweak any interval in the Builder first.
              </p>

              {pageFile && (
                <a
                  href={`../hybrid-crew/${pageFile}`}
                  className="btn-ghost h-9 px-3 text-[12px] inline-flex items-center gap-1.5 mb-4"
                  title="Open the full calendar on the hub"
                >
                  Open full calendar ↗
                </a>
              )}

              {entries === null && (
                <div className="text-center text-[var(--color-ink-faint)] text-[13px] py-10">Loading your calendar…</div>
              )}

              {entries && entries.length === 0 && (
                <div className="text-center text-[var(--color-ink-dim)] text-[13px] py-8 leading-relaxed">
                  {error ? "Couldn't reach your calendar right now." : "No programmed days found."}
                  {pageFile && (
                    <div className="mt-2 text-[12px] text-[var(--color-ink-faint)]">Open the full calendar above and tap “Do this in RoxLive” on any day.</div>
                  )}
                </div>
              )}

              {entries && entries.length > 0 && (
                <div className="space-y-1.5">
                  {entries.map((e) => (
                    <button
                      key={e.key}
                      onClick={() => onPick(incomingToPlan(e))}
                      className="w-full text-left rounded-xl bg-white/[0.025] border border-[var(--color-line)] hover:border-[var(--color-volt)] hover:bg-white/[0.04] transition-colors p-3 flex items-center gap-3"
                      style={e.isToday ? { borderColor: "var(--color-volt)" } : undefined}
                    >
                      <div className="shrink-0 w-[92px]">
                        <div className="text-[11px] mono text-[var(--color-ink-faint)]">{e.dateLabel}</div>
                        {e.isToday && <div className="text-[9px] tracking-wider font-bold text-[var(--color-volt)]">TODAY</div>}
                        {e.phase && !e.isToday && <div className="text-[9px] tracking-wide text-[var(--color-ink-faint)] truncate">{e.phase}</div>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-[var(--color-ink)] truncate">{e.title}</div>
                        {(e.summary || e.sections) && (
                          <div className="text-[11px] text-[var(--color-ink-dim)] line-clamp-2">
                            {e.summary || e.sections?.flatMap((s) => s.items).join(" · ")}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 text-[var(--color-volt)] text-lg">›</span>
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
