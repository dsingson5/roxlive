import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AthleteProfile, SessionSummary } from "../types";
import { fetchRoster, fetchUserActivity, fetchUserHistory, type RosterEntry, type ActivityEvent } from "../lib/sync";
import { prettyUser } from "../lib/user";
import { modalityDef } from "../lib/modality";
import { fmtClock, fmtNum } from "../lib/format";

/** Coach-only crew dashboard: each athlete's sign-ins, activity, and workouts.
 *  The Worker enforces that only the admin (david) can read this. */
export function AdminPanel({ open, profile, onClose }: { open: boolean; profile: AthleteProfile; onClose: () => void }) {
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [hist, setHist] = useState<SessionSummary[] | null>(null);
  const [acts, setActs] = useState<ActivityEvent[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setSel(null);
    setLoading(true);
    fetchRoster().then((r) => {
      setRoster(r || []);
      setLoading(false);
    });
  }, [open]);

  useEffect(() => {
    if (!sel) return;
    setHist(null);
    setActs(null);
    fetchUserHistory(sel).then(setHist);
    fetchUserActivity(sel).then(setActs);
  }, [sel]);

  void profile; // reserved for future per-athlete zone context

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            className="fixed right-0 top-0 bottom-0 z-50 w-[min(560px,96vw)] bg-[var(--color-bg2)] border-l border-[var(--color-line2)] p-5 sm:p-6 overflow-y-auto"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-[var(--font-display)] text-xl font-bold">
                {sel ? `${prettyUser(sel)}` : "Coach Dashboard"}
              </h2>
              <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
            </div>

            {!sel ? (
              <>
                <p className="text-[12px] text-[var(--color-ink-faint)] mb-4">
                  Crew sign-ins, activity &amp; workouts. Athletes can see their coach views this.
                </p>
                {loading && <div className="text-[13px] text-[var(--color-ink-faint)]">Loading…</div>}
                {!loading && roster && roster.length === 0 && (
                  <div className="card p-6 text-center text-[var(--color-ink-faint)] text-sm">No data yet.</div>
                )}
                <div className="space-y-2">
                  {(roster || []).map((r) => (
                    <button key={r.user} onClick={() => setSel(r.user)} className="card p-3 w-full text-left hover:border-[var(--color-line2)] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[14px] text-[var(--color-ink)]">{prettyUser(r.user)}</span>
                        <span className="text-[10px] mono text-[var(--color-ink-faint)]">{r.enrolled ? lastSeen(r) : "never signed in"}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] mono text-[var(--color-ink-dim)] mt-1.5">
                        <span>{r.workoutCount} workout{r.workoutCount === 1 ? "" : "s"}</span>
                        <span>{r.loginCount} login{r.loginCount === 1 ? "" : "s"}</span>
                        <span>{r.eventCount} events</span>
                        {r.mustChange && <span className="text-[var(--color-amber)]" title="Still using their name as password">⚠ default pw</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <button onClick={() => setSel(null)} className="text-[12px] text-[var(--color-cyan)] hover:underline mb-3">← All athletes</button>

                <div className="card-title mb-2">Recent activity</div>
                {acts == null ? (
                  <div className="text-[12px] text-[var(--color-ink-faint)] mb-4">Loading…</div>
                ) : acts.length === 0 ? (
                  <div className="text-[12px] text-[var(--color-ink-faint)] mb-4">No activity recorded.</div>
                ) : (
                  <div className="space-y-1 mb-5">
                    {acts.slice(0, 60).map((e, i) => (
                      <div key={i} className="flex items-center justify-between text-[12px]">
                        <span className="text-[var(--color-ink-dim)]">{actLabel(e)}</span>
                        <span className="mono text-[10px] text-[var(--color-ink-faint)] shrink-0 ml-3">{fmtAgo(e.t)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="card-title mb-2">Workouts</div>
                {hist == null ? (
                  <div className="text-[12px] text-[var(--color-ink-faint)]">Loading…</div>
                ) : hist.length === 0 ? (
                  <div className="text-[12px] text-[var(--color-ink-faint)]">No saved workouts.</div>
                ) : (
                  <div className="space-y-2">
                    {hist.map((s) => (
                      <div key={s.id} className="card p-3">
                        <div className="flex items-center gap-2 mb-1">
                          {s.modality && <span title={modalityDef(s.modality).label}>{modalityDef(s.modality).glyph}</span>}
                          <span className="text-[12px] font-semibold text-[var(--color-ink)] truncate">
                            {s.mode === "workout" ? s.planTitle ?? "Guided workout" : s.mode === "hyrox" ? "HYROX" : "Analyzer"}
                          </span>
                          <span className="mono text-[10px] text-[var(--color-ink-faint)] ml-auto shrink-0">{fmtDate(s.startedAt)}</span>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] mono text-[var(--color-ink-dim)]">
                          <span>{fmtClock(s.durationSec)}</span>
                          <span>♥ {fmtNum(s.avgHr)}avg</span>
                          <span>{fmtNum(s.maxHr)}max</span>
                          {s.rpe?.overall != null && <span className="text-[var(--color-amber)]">RPE {s.rpe.overall}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function lastSeen(r: RosterEntry): string {
  const t = Math.max(r.lastActive || 0, r.lastLogin || 0);
  return t ? `seen ${fmtAgo(t)}` : "—";
}

function actLabel(e: ActivityEvent): string {
  switch (e.type) {
    case "login": return "Signed in";
    case "open": return "Opened the app";
    case "mode": return `Opened ${e.detail || "a mode"}`;
    case "workout_start": return `Started: ${e.detail || "workout"}`;
    case "workout_done": return `Finished a workout${e.detail ? ` (${e.detail})` : ""}`;
    case "history_view": return "Viewed history";
    case "password_change": return "Changed password";
    default: return e.type + (e.detail ? `: ${e.detail}` : "");
  }
}

function fmtAgo(t: number): string {
  if (!t) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function fmtDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
