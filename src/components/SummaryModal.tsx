import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { RpeLog, SeriesPoint, SessionSummary } from "../types";
import type { PostResult } from "../lib/strava";
import { modalityDef } from "../lib/modality";
import { Sparkline } from "./Charts";
import { ZONE_DEFS } from "../lib/zones";
import { downloadFit } from "../lib/fit";
import { RpeScale } from "./RpeScale";
import { fmtClock, fmtDist, fmtNum, fmtSigned } from "../lib/format";

export function SummaryModal({
  summary,
  fullSeries,
  strava,
  onRpe,
  onFeel,
  onRepeat,
  unsaved,
  onKeep,
  onClose,
}: {
  summary: SessionSummary | null;
  /** full-resolution (1 Hz) series for the .FIT export */
  fullSeries: SeriesPoint[];
  strava?: {
    connected: boolean;
    post: (summary: SessionSummary, series: SeriesPoint[], opts: { name: string; description: string }) => Promise<PostResult>;
  };
  /** persist an RPE log for this session */
  onRpe?: (rpe: RpeLog) => void;
  /** persist the overall how-you-feel check */
  onFeel?: (feel: "strong" | "normal" | "weak") => void;
  /** when viewing a past session: load this workout and arm it to do again now */
  onRepeat?: () => void;
  /** true when this session is <10 s and not yet recorded — ask keep/delete */
  unsaved?: boolean;
  /** keep (record) an unsaved short session */
  onKeep?: () => void;
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
              <div className="flex items-center gap-2 flex-wrap mb-5">
                <div className="mono text-[11px] text-[var(--color-ink-faint)]">
                  {summary.mode === "hyrox" ? "HYROX simulation" : summary.mode === "workout" ? summary.planTitle ?? "Guided workout" : "Free analyzer"} · {fmtClock(summary.durationSec)}
                </div>
                {summary.modality && (
                  <span className="inline-flex items-center gap-1 px-2 h-5 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[10px] text-[var(--color-ink-dim)]">
                    {modalityDef(summary.modality).glyph} {modalityDef(summary.modality).label}
                  </span>
                )}
              </div>

              {unsaved && (
                <div className="card p-3 mb-4" style={{ borderColor: "rgba(255,176,46,0.4)" }}>
                  <div className="text-[13px] text-[var(--color-ink-dim)] mb-2">
                    ⏱ Only {fmtClock(summary.durationSec)} — too short to log automatically. Keep it anyway, or delete?
                  </div>
                  <div className="flex gap-2">
                    <button onClick={onClose} className="btn-ghost flex-1 h-10 text-sm" style={{ color: "var(--color-red)", borderColor: "rgba(255,77,77,0.35)" }}>Delete</button>
                    <button onClick={onKeep} className="btn-volt flex-1 h-10 text-sm font-semibold">Keep it</button>
                  </div>
                </div>
              )}

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

              {onRepeat && (
                <button
                  onClick={onRepeat}
                  className="btn-volt w-full h-12 mt-5 text-sm font-bold flex items-center justify-center gap-2"
                  title="Load this workout and do it again now"
                >
                  ↻ Do this workout again
                </button>
              )}

              {onFeel && <FeelSection summary={summary} onFeel={onFeel} />}

              {onRpe && <RpeSection summary={summary} onRpe={onRpe} />}

              {strava?.connected && (
                <StravaPost summary={summary} series={fullSeries.length ? fullSeries : summary.series} post={strava.post} />
              )}

              <div className="flex gap-2 mt-4">
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
                .FIT includes 1 Hz heart rate + cadence, laps per interval, and session totals.
              </p>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function FeelSection({ summary, onFeel }: { summary: SessionSummary; onFeel: (f: "strong" | "normal" | "weak") => void }) {
  const [feel, setFeel] = useState<"strong" | "normal" | "weak" | null>(summary.feel ?? null);
  const opts: { id: "strong" | "normal" | "weak"; label: string; glyph: string; color: string }[] = [
    { id: "strong", label: "Strong", glyph: "💪", color: "var(--color-mint)" },
    { id: "normal", label: "Normal", glyph: "🙂", color: "var(--color-cyan)" },
    { id: "weak", label: "Weak", glyph: "🥱", color: "var(--color-amber)" },
  ];
  return (
    <div className="card p-4 mt-4">
      <div className="card-title mb-2">How do you feel overall?</div>
      <div className="grid grid-cols-3 gap-2">
        {opts.map((o) => {
          const active = feel === o.id;
          return (
            <button
              key={o.id}
              onClick={() => { setFeel(o.id); onFeel(o.id); }}
              className="rounded-xl border h-16 flex flex-col items-center justify-center gap-1 transition-colors"
              style={{
                borderColor: active ? o.color : "var(--color-line)",
                background: active ? "rgba(255,255,255,0.05)" : "transparent",
                color: active ? o.color : "var(--color-ink-dim)",
              }}
            >
              <span className="text-xl leading-none">{o.glyph}</span>
              <span className="text-[12px] font-semibold">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RpeSection({ summary, onRpe }: { summary: SessionSummary; onRpe: (rpe: RpeLog) => void }) {
  const [rpe, setRpe] = useState<RpeLog>(summary.rpe ?? { overall: null, perSegment: {} });
  const [perOpen, setPerOpen] = useState(false);

  const update = (next: RpeLog) => {
    setRpe(next);
    onRpe(next);
  };
  const setOverall = (v: number) => update({ ...rpe, overall: v });
  const setSeg = (i: number, v: number) => update({ ...rpe, perSegment: { ...(rpe.perSegment ?? {}), [i]: v } });

  const hasSegments = summary.segments.length > 0;

  return (
    <div className="card p-4 mt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="card-title">How hard was it? (RPE)</div>
        {hasSegments && (
          <button onClick={() => setPerOpen((o) => !o)} className="text-[11px] text-[var(--color-cyan)]">
            {perOpen ? "hide per-interval" : "log per-interval"}
          </button>
        )}
      </div>
      <RpeScale value={rpe.overall} onChange={setOverall} />

      <AnimatePresence>
        {perOpen && hasSegments && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-3 space-y-2 pt-2 border-t border-[var(--color-line)]">
              {summary.segments.map((s) => (
                <div key={s.index}>
                  <div className="text-[11px] text-[var(--color-ink-dim)] mb-1">{s.label}</div>
                  <RpeScale value={rpe.perSegment?.[s.index] ?? null} onChange={(v) => setSeg(s.index, v)} size="sm" />
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Branded default title for a Strava upload, tailored to the session type. */
function stravaDefaultName(summary: SessionSummary): string {
  const brand = "RoxLive by Hybrid Crew";
  if (summary.mode === "hyrox") return `HYROX · ${brand}`;
  if (summary.mode === "workout") return `${summary.planTitle?.trim() || "Workout"} · ${brand}`;
  // Free session — name it after the sport when we know it.
  const sport = summary.modality && summary.modality !== "mixed" ? modalityDef(summary.modality).label : null;
  return sport ? `${sport} · ${brand}` : `${brand} session`;
}

function StravaPost({
  summary,
  series,
  post,
}: {
  summary: SessionSummary;
  series: SeriesPoint[];
  post: (s: SessionSummary, ser: SeriesPoint[], o: { name: string; description: string }) => Promise<PostResult>;
}) {
  const defaultName = stravaDefaultName(summary);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [desc, setDesc] = useState("Recorded with RoxLive by Hybrid Crew");
  const [state, setState] = useState<"idle" | "posting" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const go = async () => {
    setState("posting");
    setMsg(null);
    const res = await post(summary, series, { name, description: desc });
    if (res.ok) {
      setState("done");
      setMsg(`Uploaded — Strava is processing it${res.status ? ` (${res.status})` : ""}.`);
    } else {
      setState("error");
      setMsg(res.error || "Upload failed.");
    }
  };

  if (state === "done") {
    return (
      <div className="card p-3 mt-4 flex items-center gap-2" style={{ borderColor: "rgba(252,76,2,0.4)" }}>
        <span className="w-2 h-2 rounded-full bg-[#fc4c02]" />
        <span className="text-[12px] text-[var(--color-ink-dim)]">{msg}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full h-11 mt-4 text-sm rounded-xl font-semibold flex items-center justify-center gap-2"
        style={{ background: "#fc4c02", color: "white" }}
      >
        Post to Strava
      </button>
    );
  }

  return (
    <div className="card p-4 mt-4" style={{ borderColor: "rgba(252,76,2,0.4)" }}>
      <div className="card-title mb-2" style={{ color: "#fc4c02" }}>Post to Strava — confirm</div>
      <input value={name} onChange={(e) => setName(e.target.value)} className="inp mb-2" placeholder="Activity name" />
      <input value={desc} onChange={(e) => setDesc(e.target.value)} className="inp" placeholder="Description" />
      {msg && state === "error" && <div className="text-[11px] text-[var(--color-red)] mt-2">{msg}</div>}
      <div className="flex gap-2 mt-3">
        <button
          onClick={go}
          disabled={state === "posting"}
          className="flex-1 h-10 text-sm rounded-xl font-semibold disabled:opacity-50"
          style={{ background: "#fc4c02", color: "white" }}
        >
          {state === "posting" ? "Uploading…" : "Confirm & post"}
        </button>
        <button onClick={() => setOpen(false)} disabled={state === "posting"} className="btn-ghost px-4 h-10 text-sm">Cancel</button>
      </div>
      <p className="text-[10px] text-[var(--color-ink-faint)] mt-2">Uploads this session's .FIT to your Strava account. Nothing posts until you confirm.</p>
    </div>
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
