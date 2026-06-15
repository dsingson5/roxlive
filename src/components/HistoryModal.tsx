import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SessionSummary } from "../types";
import { modalityDef, type Modality } from "../lib/modality";
import { Sparkline } from "./Charts";
import { ZONE_DEFS } from "../lib/zones";
import { fmtClock, fmtDist, fmtNum } from "../lib/format";

const MODE_LABEL: Record<SessionSummary["mode"], string> = {
  free: "Analyzer",
  hyrox: "HYROX",
  workout: "Workout",
};
const MODE_COLOR: Record<SessionSummary["mode"], string> = {
  free: "var(--color-cyan)",
  hyrox: "var(--color-volt)",
  workout: "var(--color-mint)",
};

export function HistoryModal({
  open,
  sessions,
  userLabel,
  synced,
  onClose,
  onOpen,
  onRepeat,
  onDelete,
  onClear,
}: {
  open: boolean;
  sessions: SessionSummary[];
  /** signed-in Hybrid Crew athlete, e.g. "David" — empty when anonymous */
  userLabel?: string;
  /** true when signed in + syncing to the cloud */
  synced?: boolean;
  onClose: () => void;
  onOpen: (s: SessionSummary) => void;
  /** load this past workout and arm it to do again now */
  onRepeat: (s: SessionSummary) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  const [filter, setFilter] = useState<Modality | "all">("all");

  // Modalities actually present in saved sessions (for the filter chips).
  const present = useMemo(() => {
    const seen = new Set<Modality>();
    for (const s of sessions) if (s.modality) seen.add(s.modality);
    return Array.from(seen);
  }, [sessions]);

  const shown = filter === "all" ? sessions : sessions.filter((s) => s.modality === filter);

  return (
    <AnimatePresence>
      {open && [
          <motion.div key="hist-backdrop" className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />,
          <motion.aside
            key="hist-panel"
            className="fixed right-0 top-0 bottom-0 z-50 w-[min(560px,96vw)] bg-[var(--color-bg2)] border-l border-[var(--color-line2)] p-5 sm:p-6 overflow-y-auto"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-[var(--font-display)] text-xl font-bold">
                {userLabel ? `${userLabel}'s History` : "Workout History"}
              </h2>
              <button onClick={onClose} className="btn-ghost w-8 h-8 grid place-items-center text-lg">×</button>
            </div>
            <p className="text-[12px] text-[var(--color-ink-faint)] mb-4">
              {userLabel && <span className="text-[var(--color-volt)]">✦ {userLabel} · </span>}
              {sessions.length === 0
                ? "No sessions yet — finished workouts will appear here."
                : `${sessions.length} saved session${sessions.length === 1 ? "" : "s"} · ${synced ? "synced across your devices" : "stored on this device"}`}
            </p>

            {present.length > 1 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                <FilterChip label="All" count={sessions.length} active={filter === "all"} onClick={() => setFilter("all")} />
                {present.map((m) => (
                  <FilterChip
                    key={m}
                    label={`${modalityDef(m).glyph} ${modalityDef(m).short}`}
                    count={sessions.filter((s) => s.modality === m).length}
                    active={filter === m}
                    onClick={() => setFilter(m)}
                  />
                ))}
              </div>
            )}

            {sessions.length === 0 ? (
              <div className="card p-8 text-center text-[var(--color-ink-faint)]">
                <div className="text-3xl mb-2">🗓️</div>
                <div className="text-sm">Hit Stop after a session to save it here.</div>
              </div>
            ) : shown.length === 0 ? (
              <div className="card p-8 text-center text-[var(--color-ink-faint)]">
                <div className="text-sm">No {filter !== "all" ? modalityDef(filter).label.toLowerCase() : ""} sessions.</div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {shown.map((s) => (
                  <HistoryRow key={s.id} s={s} onOpen={() => onOpen(s)} onRepeat={() => onRepeat(s)} onDelete={() => onDelete(s.id)} />
                ))}
              </div>
            )}

            {sessions.length > 0 && (
              <button
                onClick={onClear}
                className="btn-ghost w-full h-10 mt-5 text-[13px]"
                style={{ color: "var(--color-red)", borderColor: "rgba(255,77,77,0.3)" }}
              >
                Clear all history
              </button>
            )}
          </motion.aside>,
      ]}
    </AnimatePresence>
  );
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 h-7 rounded-full text-[11px] border transition-colors ${
        active
          ? "bg-[var(--color-volt)] text-black border-transparent font-semibold"
          : "bg-[var(--color-surface-2)] text-[var(--color-ink-dim)] border-[var(--color-line)] hover:text-[var(--color-ink)]"
      }`}
    >
      {label} <span className={active ? "opacity-70" : "text-[var(--color-ink-faint)]"}>{count}</span>
    </button>
  );
}

function HistoryRow({ s, onOpen, onRepeat, onDelete }: { s: SessionSummary; onOpen: () => void; onRepeat: () => void; onDelete: () => void }) {
  const date = new Date(s.startedAt);
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const totalZone = s.zoneTimeSec.reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="card p-3 hover:border-[var(--color-line2)] transition-colors group">
      <div className="flex items-center gap-3">
        <button onClick={onOpen} className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide" style={{ color: MODE_COLOR[s.mode], background: "rgba(255,255,255,0.05)" }}>
              {MODE_LABEL[s.mode]}
            </span>
            {s.modality && (
              <span className="text-[10px] text-[var(--color-ink-faint)]" title={modalityDef(s.modality).label}>
                {modalityDef(s.modality).glyph} {modalityDef(s.modality).short}
              </span>
            )}
            <span className="text-[12px] text-[var(--color-ink)] font-semibold truncate">
              {s.mode === "workout" ? s.planTitle ?? "Guided workout" : MODE_LABEL[s.mode] + " session"}
            </span>
          </div>
          <div className="text-[10px] mono text-[var(--color-ink-faint)]">{dateStr} · {timeStr} · {fmtClock(s.durationSec)}</div>

          {/* mini zone bar */}
          <div className="flex h-1.5 rounded-full overflow-hidden mt-2 mb-2 w-full max-w-[220px]">
            {ZONE_DEFS.map((z, i) => {
              const pct = (s.zoneTimeSec[i] / totalZone) * 100;
              return pct > 0 ? <div key={z.z} style={{ width: `${pct}%`, background: z.color }} /> : null;
            })}
          </div>

          <div className="flex items-center gap-3 text-[10px] mono text-[var(--color-ink-dim)]">
            <span>♥ {fmtNum(s.avgHr)}<span className="text-[var(--color-ink-faint)]">avg</span></span>
            <span>{fmtNum(s.maxHr)}<span className="text-[var(--color-ink-faint)]">max</span></span>
            {s.distanceM > 0 && <span>{fmtDist(s.distanceM)}</span>}
            {s.mode === "workout" && s.adherencePct != null && (
              <span style={{ color: s.adherencePct >= 70 ? "var(--color-mint)" : "var(--color-amber)" }}>{Math.round(s.adherencePct)}% in zone</span>
            )}
            {s.minAlpha1 != null && <span className="text-[var(--color-cyan)]">α1 {s.minAlpha1.toFixed(2)}</span>}
            {s.rpe?.overall != null && <span className="text-[var(--color-amber)]">RPE {s.rpe.overall}</span>}
          </div>
        </button>

        <div className="flex flex-col items-end gap-2 shrink-0">
          <Sparkline data={s.series.map((p) => p.hr)} color={MODE_COLOR[s.mode]} width={92} height={34} />
          <button
            onClick={onDelete}
            className="text-[var(--color-ink-faint)] hover:text-[var(--color-red)] text-sm w-6 h-6 grid place-items-center transition-colors"
            title="Delete session — only removes it for you"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Repeat — load this exact workout and arm it to do again now. */}
      <button
        onClick={onRepeat}
        className="mt-2.5 w-full h-9 rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors"
        style={{ background: "rgba(255,255,255,0.04)", color: MODE_COLOR[s.mode], border: "1px solid var(--color-line)" }}
        title="Load this workout and do it again now"
      >
        ↻ Do this workout again
      </button>
    </div>
  );
}
