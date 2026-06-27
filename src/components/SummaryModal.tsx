import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AthleteProfile, RecoverySnap, RpeLog, SeriesPoint, SessionSummary } from "../types";
import type { PostResult } from "../lib/strava";
import { analyzeWorkout, readAttachment, type AttachedFile } from "../lib/coach";
import { sessionUser } from "../lib/sync";
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
  recovering,
  liveRecovery,
  onFinishRecovery,
  apiKey,
  model,
  profile,
  onAnalysis,
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
  /** true while the post-stop recovery window is still capturing (HRM stays on) */
  recovering?: boolean;
  /** live recovery snapshot during the capture window */
  liveRecovery?: RecoverySnap;
  /** finish the recovery capture early + disconnect */
  onFinishRecovery?: () => void;
  /** Anthropic API key + model for the post-run AI analysis (from Settings) */
  apiKey?: string;
  model?: string;
  profile?: AthleteProfile;
  /** persist Claude's analysis onto the session */
  onAnalysis?: (text: string) => void;
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

              {/* Recovery HR — live capture window (HRM stays on), then the result. */}
              {recovering && (
                <div className="card p-4 mb-4" style={{ borderColor: "var(--color-volt)", background: "rgba(216,255,58,0.06)" }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">⌚</span>
                    <div className="card-title" style={{ color: "var(--color-volt)" }}>Recovery HR — keep your HRM on</div>
                    <div className="ml-auto num text-sm text-[var(--color-ink-dim)]">
                      {liveRecovery ? `${Math.max(0, 60 - liveRecovery.secsSince)}s left` : ""}
                    </div>
                  </div>
                  <div className="text-[12px] text-[var(--color-ink-dim)] mb-2">Don't remove the strap — measuring how fast your heart rate drops after stopping.</div>
                  <div className="flex gap-4">
                    <RecStat label="peak" value={liveRecovery?.peakHr != null ? String(liveRecovery.peakHr) : "—"} unit="bpm" />
                    <RecStat label="30 s drop" value={liveRecovery?.hrr30 != null ? `−${liveRecovery.hrr30}` : "…"} unit="bpm" />
                    <RecStat label="1 min drop" value={liveRecovery?.hrr60 != null ? `−${liveRecovery.hrr60}` : "…"} unit="bpm" />
                  </div>
                  <button onClick={onFinishRecovery} className="btn-ghost w-full h-9 mt-3 text-[13px]">Finish &amp; disconnect now</button>
                </div>
              )}
              {!recovering && summary.recovery && (summary.recovery.hrr30 != null || summary.recovery.hrr60 != null) && (
                <div className="card p-4 mb-4">
                  <div className="card-title mb-2">Heart-Rate Recovery</div>
                  <div className="flex gap-4">
                    <RecStat label="peak" value={String(summary.recovery.peakHr)} unit="bpm" />
                    <RecStat label="30 s drop" value={summary.recovery.hrr30 != null ? `−${summary.recovery.hrr30}` : "—"} unit="bpm" accent="var(--color-mint)" />
                    <RecStat label="1 min drop" value={summary.recovery.hrr60 != null ? `−${summary.recovery.hrr60}` : "—"} unit="bpm" accent="var(--color-mint)" />
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-faint)] mt-2">A bigger 1-minute drop means faster recovery — a sign of aerobic fitness. Saved with the session &amp; written to the .FIT.</div>
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

              {!recovering && (
                <CoachAnalysis key={summary.id} summary={summary} apiKey={apiKey} model={model} profile={profile} onAnalysis={onAnalysis} />
              )}

              {onRpe && <RpeSection summary={summary} onRpe={onRpe} />}

              {strava?.connected && !recovering && (
                <StravaPost summary={summary} series={fullSeries.length ? fullSeries : summary.series} post={strava.post} />
              )}
              {recovering && (
                <div className="text-[12px] text-[var(--color-ink-faint)] mt-3">Export &amp; Strava unlock once recovery HR is captured — finish above, or wait for the countdown.</div>
              )}

              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => downloadFit(summary, fullSeries.length ? fullSeries : summary.series)}
                  disabled={recovering}
                  className="btn-ghost flex-1 h-11 text-sm disabled:opacity-40"
                  title={recovering ? "Finishing recovery capture…" : "Garmin FIT activity — import into Garmin Connect, Strava, TrainingPeaks…"}
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

/**
 * Drop a date segment from a calendar-derived title. The calendar importer joins
 * "title · date", so the date rides into the Strava name — strip any ' · '/'-'
 * segment that is ENTIRELY date tokens (ISO, slash-date, weekday, month, day),
 * leaving real workout text like "Bike 4×4" or "Zone 2" untouched.
 */
function stripDate(title: string): string {
  const DATEY = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{1,4}(?:st|nd|rd|th)?)\b/gi;
  const isDateSeg = (s: string) => s.trim().length > 0 && s.replace(DATEY, "").replace(/[\s,.\-–—]/g, "") === "";
  const parts = title.split(/\s*[·•|]\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((p) => !isDateSeg(p)).join(" · "); // "" if the title was only a date → caller falls back
}

/** Clean default title for a Strava upload — just the workout, no branding
 *  (the brand lives in the Description; full detail goes in Private Notes). */
function stravaDefaultName(summary: SessionSummary): string {
  if (summary.mode === "hyrox") return "HYROX";
  if (summary.mode === "workout") return stripDate(summary.planTitle?.trim() || "") || "Workout";
  // Free session — name it after the sport when we know it.
  const sport = summary.modality && summary.modality !== "mixed" ? modalityDef(summary.modality).label : null;
  return sport ? `${sport} session` : "Workout";
}

/** A full, copy-pasteable workout breakdown for Strava's Private Notes (the API
 *  can't write Private Notes, so we surface it for a one-tap copy + manual paste). */
function buildWorkoutNotes(s: SessionSummary): string {
  const title = s.mode === "hyrox" ? "HYROX simulation" : s.mode === "workout" ? stripDate(s.planTitle?.trim() || "") || "Guided workout" : "Free session";
  const L: string[] = [`${title} — ${fmtClock(s.activeSec ?? s.durationSec)} active`];
  const a: string[] = [];
  if (s.avgHr != null) a.push(`avg HR ${Math.round(s.avgHr)}`);
  if (s.maxHr != null) a.push(`max HR ${Math.round(s.maxHr)}`);
  if (s.distanceM > 0) a.push(fmtDist(s.distanceM));
  if (s.kcal) a.push(`${Math.round(s.kcal)} kcal`);
  if (a.length) L.push(a.join(" · "));
  const b: string[] = [];
  if (s.adherencePct != null) b.push(`target adherence ${Math.round(s.adherencePct)}%`);
  if (s.decouplingPct != null) b.push(`decoupling ${fmtSigned(s.decouplingPct, 1)}%`);
  if (s.minAlpha1 != null) b.push(`min α1 ${s.minAlpha1.toFixed(2)}`);
  if (s.avgBrpm != null) b.push(`avg breath ${Math.round(s.avgBrpm)}/min`);
  if (b.length) L.push(b.join(" · "));
  const r = s.recovery;
  if (r && (r.hrr30 != null || r.hrr60 != null)) {
    const p: string[] = [];
    if (r.hrr30 != null) p.push(`−${r.hrr30} bpm @30s`);
    if (r.hrr60 != null) p.push(`−${r.hrr60} bpm @1min`);
    L.push(`Recovery HR: ${p.join(", ")} (peak ${r.peakHr})`);
  }
  const segs = (s.segments ?? []).filter((x) => x.splitSec != null);
  if (segs.length) {
    L.push("", "Splits:");
    segs.forEach((x, i) => {
      const hr = x.avgHr != null ? ` · avg ${Math.round(x.avgHr)}${x.maxHr != null ? `/max ${Math.round(x.maxHr)}` : ""}` : "";
      const d = x.distanceM > 0 ? ` · ${fmtDist(x.distanceM)}` : "";
      L.push(`${i + 1}. ${x.label} — ${fmtClock(x.splitSec as number)}${hr}${d}`);
    });
  }
  L.push("", "Recorded with RoxLive by Hybrid Crew");
  return L.join("\n");
}

/** Post-run AI analysis: Claude's read of the session + recovery guidance. */
function CoachAnalysis({
  summary,
  apiKey,
  model,
  profile,
  onAnalysis,
}: {
  summary: SessionSummary;
  apiKey?: string;
  model?: string;
  profile?: AthleteProfile;
  onAnalysis?: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [userNote, setUserNote] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const note = summary.coachNote;
  const hasData = summary.avgHr != null || summary.distanceM > 0;
  const canAnalyze = !!apiKey && !!profile && hasData;

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setMsg(null);
    const picked = Array.from(list);
    const next: AttachedFile[] = [];
    for (const f of picked) {
      if (files.length + next.length >= 6) { setMsg("Up to 6 files per analysis."); break; }
      const r = await readAttachment(f);
      if ("error" in r) { setMsg(r.error); continue; }
      next.push(r);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
    if (fileRef.current) fileRef.current.value = ""; // allow re-picking the same file
  };
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));

  const run = async () => {
    if (!apiKey || !profile) return;
    setState("loading");
    setMsg(null);
    const r = await analyzeWorkout({ summary, profile, apiKey, model: model || "claude-sonnet-4-6", userNote, files });
    if (r.ok && r.text) {
      onAnalysis?.(r.text);
      setState("idle");
    } else {
      setState("error");
      setMsg(r.error || "Analysis failed.");
    }
  };

  // Notes + attachments composer (shown whenever an analysis can run).
  const composer = canAnalyze && (
    <div className="mt-3">
      <textarea
        value={userNote}
        onChange={(e) => setUserNote(e.target.value)}
        placeholder="Add context for Claude (optional) — how you felt, sleep, soreness, weather, fuelling…"
        rows={2}
        className="w-full rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-line)] px-3 py-2 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] resize-y"
      />
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button onClick={() => fileRef.current?.click()} className="btn-ghost h-8 px-3 text-[12px]">📎 Attach files</button>
        <input ref={fileRef} type="file" multiple accept="image/*,application/pdf,.txt,.md,.csv,.json,.log" className="hidden" onChange={(e) => addFiles(e.target.files)} />
        <span className="text-[10px] text-[var(--color-ink-faint)]">Photos, PDFs or notes (e.g. meal, sleep, course) — up to 6</span>
      </div>
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {files.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] px-2 py-1 text-[11px] text-[var(--color-ink-dim)]">
              {f.kind === "image" ? "🖼" : f.kind === "pdf" ? "📄" : "📝"} <span className="max-w-[140px] truncate">{f.name}</span>
              <button onClick={() => removeFile(i)} className="text-[var(--color-ink-faint)] hover:text-[var(--color-red)]" title="Remove">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="card p-4 mb-4" style={{ borderColor: "rgba(124,109,242,0.35)" }}>
      <div className="card-title mb-1">🧠 Coach analysis</div>
      <div className="text-[10px] text-[var(--color-ink-faint)] mb-2">AI training guidance from your run data — general advice, not medical advice.</div>
      {note && <div className="text-[13px] text-[var(--color-ink-dim)] whitespace-pre-wrap leading-relaxed mb-1">{note}</div>}
      {note && sessionUser() === "david" && (
        <div className="text-[11px] text-[var(--color-volt)] mb-1">✓ Saved to your Year Calendar &amp; Training Progress pages.</div>
      )}
      {!apiKey ? (
        <div className="text-[12px] text-[var(--color-ink-dim)]">Add your Anthropic API key in Settings to get Claude's read of this run and what to do for recovery.</div>
      ) : !hasData ? (
        <div className="text-[12px] text-[var(--color-ink-faint)]">Not enough data to analyze.</div>
      ) : (
        <>
          {!note && <div className="text-[12px] text-[var(--color-ink-dim)]">Get Claude's read of this session and what to do for recovery next.</div>}
          {composer}
          <button onClick={run} disabled={state === "loading"} className={`${note ? "btn-ghost h-8 px-3 text-[12px]" : "btn-volt h-10 px-4 text-sm font-semibold"} mt-3 disabled:opacity-50`}>
            {state === "loading" ? "Analyzing…" : note ? "↻ Re-analyze" : "✨ Analyze with Claude"}
          </button>
        </>
      )}
      {state === "error" && msg && <div className="text-[11px] text-[var(--color-red)] mt-2">{msg}</div>}
      {state !== "error" && msg && <div className="text-[11px] text-[var(--color-amber,#f59e0b)] mt-2">{msg}</div>}
    </div>
  );
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
  const [desc, setDesc] = useState("RoxLive by Hybrid Crew");
  const [state, setState] = useState<"idle" | "posting" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const notes = buildWorkoutNotes(summary);
  const [copied, setCopied] = useState(false);
  const copyNotes = async () => {
    try { await navigator.clipboard.writeText(notes); setCopied(true); window.setTimeout(() => setCopied(false), 2500); } catch { /* clipboard blocked */ }
  };

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
      <label className="text-[10px] tracking-[0.1em] uppercase text-[var(--color-ink-faint)]">Title</label>
      <input value={name} onChange={(e) => setName(e.target.value)} className="inp mb-2 mt-1" placeholder="Activity name" />
      <label className="text-[10px] tracking-[0.1em] uppercase text-[var(--color-ink-faint)]">Description</label>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} className="inp mt-1" placeholder="Description" />

      {/* Full breakdown for Private Notes — Strava's API can't write Private Notes,
          so copy this and paste it into the activity's Private Notes on Strava. */}
      <div className="mt-3 rounded-xl bg-white/[0.025] border border-[var(--color-line)] p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] tracking-[0.1em] uppercase text-[var(--color-ink-faint)]">Private notes (full detail)</span>
          <button onClick={copyNotes} className="btn-ghost h-7 px-3 text-[11px]" style={copied ? { borderColor: "var(--color-mint)", color: "var(--color-mint)" } : undefined}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <pre className="text-[11px] text-[var(--color-ink-dim)] whitespace-pre-wrap font-sans max-h-32 overflow-y-auto leading-snug">{notes}</pre>
        <div className="text-[10px] text-[var(--color-ink-faint)] mt-1.5">Strava's API can't fill Private Notes — paste this into your activity → ⋯ → Edit → Private Notes.</div>
      </div>

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

/** Compact recovery-HR stat (peak / 30 s / 1 min drop). */
function RecStat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="flex-1">
      <div className="num text-2xl leading-none" style={{ color: accent ?? "var(--color-ink)" }}>
        {value}
        {unit && <span className="text-[11px] text-[var(--color-ink-faint)] ml-1">{unit}</span>}
      </div>
      <div className="text-[10px] tracking-[0.1em] text-[var(--color-ink-faint)] mt-1 uppercase">{label}</div>
    </div>
  );
}
