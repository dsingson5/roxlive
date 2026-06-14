import { useState } from "react";
import { motion } from "motion/react";
import type { MetricsSnapshot, RpeLog, WorkoutPlan } from "../types";
import type { SquadAthlete } from "../hooks/useSquad";
import type { RunnerView } from "../lib/workout";
import { ZONE_DEFS } from "../lib/zones";
import { KIND_COLOR, targetLabel } from "../lib/workout";
import { RpeScale } from "./RpeScale";
import { fmtClock } from "../lib/format";

interface Handlers {
  addAthlete: () => void;
  removeAthlete: (id: string) => void;
  setName: (id: string, n: string) => void;
  setMaxHr: (id: string, v: number) => void;
  setPlan: (id: string, p: WorkoutPlan | null) => void;
  startSim: (id: string) => void;
  connectSensor: (id: string) => void;
  startPlan: (id: string) => void;
  startAll: () => void;
  stopAll: () => void;
  pauseAthlete: (id: string) => void;
  logRpe: (id: string, rpe: RpeLog) => void;
}

export function SquadView({
  athletes,
  snapshots,
  views,
  adherence,
  running,
  pausedIds,
  plans,
  supported,
  max,
  h,
}: {
  athletes: SquadAthlete[];
  snapshots: Record<string, MetricsSnapshot>;
  views: Record<string, RunnerView>;
  adherence: Record<string, number | null>;
  running: boolean;
  pausedIds: Record<string, boolean>;
  plans: WorkoutPlan[];
  supported: boolean;
  max: number;
  h: Handlers;
}) {
  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[140px]">
          <div className="font-[var(--font-display)] text-lg font-bold">Squad</div>
          <div className="text-[11px] text-[var(--color-ink-faint)]">{athletes.length}/{max} athletes · each on the same or a different workout</div>
        </div>
        <button onClick={h.addAthlete} disabled={athletes.length >= max} className="btn-ghost h-9 px-4 text-sm disabled:opacity-40">+ Add athlete</button>
        {running ? (
          <button onClick={h.stopAll} className="btn-ghost h-9 px-4 text-sm" style={{ borderColor: "rgba(255,77,77,0.4)", color: "var(--color-red)" }}>Stop all</button>
        ) : (
          <button onClick={h.startAll} disabled={athletes.length === 0} className="btn-volt h-9 px-5 text-sm disabled:opacity-40">▶ Start all</button>
        )}
      </div>

      {athletes.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-3xl mb-2">👥</div>
          <div className="font-[var(--font-display)] text-lg font-bold">Build your squad</div>
          <p className="text-[13px] text-[var(--color-ink-dim)] mt-1 max-w-sm mx-auto">Add athletes, assign each the same or a different workout, then Start all. Each athlete uses their own strap, or a simulator.</p>
          <button onClick={h.addAthlete} className="btn-volt px-5 h-10 text-sm mt-4">+ Add your first athlete</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {athletes.map((a) => (
            <AthleteCard
              key={a.id}
              a={a}
              snap={snapshots[a.id]}
              view={views[a.id]}
              adh={adherence[a.id] ?? null}
              paused={!!pausedIds[a.id]}
              plans={plans}
              supported={supported}
              h={h}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AthleteCard({
  a,
  snap,
  view,
  adh,
  paused,
  plans,
  supported,
  h,
}: {
  a: SquadAthlete;
  snap?: MetricsSnapshot;
  view?: RunnerView;
  adh: number | null;
  paused: boolean;
  plans: WorkoutPlan[];
  supported: boolean;
  h: Handlers;
}) {
  const hr = snap?.hr ?? null;
  const zone = snap?.zone ?? 1;
  const zoneColor = hr == null ? "var(--color-ink-faint)" : ZONE_DEFS[zone - 1].color;
  const sourceLive = a.source !== "idle";
  const started = a.anchor != null;

  return (
    <div className="card p-4 flex flex-col" style={{ borderColor: started ? `${a.color}55` : "var(--color-line)" }}>
      {/* header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color, boxShadow: `0 0 8px ${a.color}` }} />
        <input
          value={a.name}
          onChange={(e) => h.setName(a.id, e.target.value)}
          className="bg-transparent border-none outline-none font-[var(--font-display)] font-semibold text-[15px] flex-1 min-w-0 focus:bg-white/5 rounded px-1"
        />
        {a.deviceName && (
          <span className="text-[9px] mono px-1.5 py-0.5 rounded" style={{ color: a.source === "sim" ? "var(--color-cyan)" : "var(--color-mint)", background: "rgba(255,255,255,0.05)" }}>
            {a.source === "sim" ? "SIM" : a.deviceName.slice(0, 10)}
          </span>
        )}
        <button onClick={() => h.removeAthlete(a.id)} className="text-[var(--color-ink-faint)] hover:text-[var(--color-red)] w-6 h-6 grid place-items-center text-sm">×</button>
      </div>

      {/* live readout */}
      <div className="flex items-center gap-4">
        <div className="text-center shrink-0" style={{ minWidth: 88 }}>
          <div className="num leading-none" style={{ fontSize: 46, color: zoneColor }}>{hr ?? "—"}</div>
          <div className="text-[9px] tracking-[0.2em] text-[var(--color-ink-faint)] mt-0.5">BPM</div>
          {snap?.pctMax != null && <div className="mono text-[10px] mt-0.5" style={{ color: zoneColor }}>{Math.round(snap.pctMax)}% · Z{zone}</div>}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <MiniRow label="Max HR" value={<input type="number" value={a.profile.maxHr} onChange={(e) => h.setMaxHr(a.id, Number(e.target.value) || a.profile.maxHr)} className="bg-transparent w-12 text-right outline-none focus:bg-white/5 rounded num text-[13px]" />} />
          {snap?.cadence != null && <MiniRow label="Cadence" value={<span className="num text-[13px] text-[var(--color-cyan)]">{Math.round(snap.cadence)} spm</span>} />}
          {snap?.bodyTempC != null && <MiniRow label="Temp" value={<span className="num text-[13px] text-[var(--color-amber)]">{snap.bodyTempC.toFixed(1)}°C</span>} />}
          {adh != null && <MiniRow label="In target" value={<span className="num text-[13px]" style={{ color: adh >= 70 ? "var(--color-mint)" : "var(--color-amber)" }}>{Math.round(adh)}%</span>} />}
        </div>
      </div>

      {/* plan assignment */}
      <select
        value={a.plan?.id ?? ""}
        onChange={(e) => h.setPlan(a.id, plans.find((p) => p.id === e.target.value) ?? null)}
        className="inp h-8 mt-3 text-[12px]"
      >
        <option value="">No workout (just read HR)</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>{p.title}</option>
        ))}
      </select>

      {/* status / controls */}
      <div className="mt-3 min-h-[40px] flex items-center">
        {view && (view.phase === "running" || (paused && view.phase !== "idle")) && view.interval ? (
          <div className="w-full">
            <RunningStrip a={a} view={view} hr={hr} />
            <div className="flex items-center justify-between mt-2">
              <button onClick={() => h.pauseAthlete(a.id)} className="btn-ghost h-7 px-3 text-[11px]" style={paused ? { borderColor: a.color, color: a.color } : undefined}>
                {paused ? "▶ Resume" : "❚❚ Pause"}
              </button>
              {paused && <span className="text-[10px] mono" style={{ color: a.color }}>PAUSED · ♥ recording</span>}
            </div>
          </div>
        ) : view && view.phase === "leadin" ? (
          <div className="text-center w-full">
            <span className="num text-2xl" style={{ color: a.color }}>{Math.ceil(view.remainingSec)}</span>
            <span className="text-[11px] text-[var(--color-ink-faint)] ml-2">get ready…</span>
          </div>
        ) : view && view.phase === "done" ? (
          <div className="text-[12px] text-[var(--color-mint)] w-full text-center">✓ Workout complete</div>
        ) : !sourceLive ? (
          <div className="flex gap-2 w-full">
            <button onClick={() => h.connectSensor(a.id)} disabled={!supported} className="btn-volt flex-1 h-8 text-[12px] disabled:opacity-40" title={supported ? "Pair this athlete's strap" : "Web Bluetooth unavailable"}>Connect</button>
            <button onClick={() => h.startSim(a.id)} className="btn-ghost flex-1 h-8 text-[12px]">Simulate</button>
          </div>
        ) : !started ? (
          <button onClick={() => h.startPlan(a.id)} disabled={!a.plan} className="btn-volt w-full h-8 text-[12px] disabled:opacity-40" title={a.plan ? "" : "Assign a workout first"}>
            {a.plan ? "▶ Start workout" : "Pick a workout to start"}
          </button>
        ) : null}
      </div>

      {/* RPE — available once the athlete has a live source (during/after) */}
      {sourceLive && <AthleteRpe a={a} onLog={(rpe) => h.logRpe(a.id, rpe)} />}
    </div>
  );
}

function AthleteRpe({ a, onLog }: { a: SquadAthlete; onLog: (rpe: RpeLog) => void }) {
  const [open, setOpen] = useState(false);
  const rpe = a.rpe ?? { overall: null, perSegment: {} };
  const update = (next: RpeLog) => onLog(next);
  return (
    <div className="mt-2 pt-2 border-t border-[var(--color-line)]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center justify-between w-full text-[11px] text-[var(--color-ink-faint)]">
        <span>RPE{rpe.overall != null ? `: ${rpe.overall}` : " — log effort"}</span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <RpeScale value={rpe.overall} onChange={(v) => update({ ...rpe, overall: v })} size="sm" />
          {a.plan && a.plan.intervals.length > 0 && (
            <details>
              <summary className="text-[10px] text-[var(--color-cyan)] cursor-pointer">per-interval</summary>
              <div className="mt-2 space-y-2">
                {a.plan.intervals.map((iv, i) => (
                  <div key={iv.id}>
                    <div className="text-[10px] text-[var(--color-ink-dim)] mb-1">{iv.name}</div>
                    <RpeScale value={rpe.perSegment?.[i] ?? null} onChange={(v) => update({ ...rpe, perSegment: { ...(rpe.perSegment ?? {}), [i]: v } })} size="sm" />
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function RunningStrip({ a, view, hr }: { a: SquadAthlete; view: RunnerView; hr: number | null }) {
  const iv = view.interval!;
  const statusMap = {
    in: { c: "var(--color-mint)", t: "on target" },
    under: { c: "var(--color-cyan)", t: "push" },
    over: { c: "var(--color-amber)", t: "ease" },
    none: { c: "var(--color-ink-faint)", t: "" },
  }[view.hrStatus];
  const cd = Math.ceil(view.remainingSec);
  const urgent = cd <= 3 && view.remainingSec > 0;
  return (
    <div className="w-full">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold" style={{ color: KIND_COLOR[iv.kind], background: "rgba(255,255,255,0.05)" }}>{iv.name}</span>
          <span className="mono text-[10px] text-[var(--color-ink-faint)] ml-1.5">{view.currentIndex + 1}/{view.totalIntervals}</span>
        </div>
        <motion.div key={cd} initial={urgent ? { scale: 1.4 } : false} animate={{ scale: 1 }} className="num text-2xl" style={{ color: urgent ? a.color : "var(--color-ink)" }}>
          {fmtClock(Math.max(0, cd))}
        </motion.div>
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-[var(--color-ink-faint)]">Target {targetLabel(iv.target, a.profile)}{view.band ? ` · ${view.band.low}-${view.band.high}` : ""}</span>
        {view.band && hr != null && <span className="text-[10px] font-semibold" style={{ color: statusMap.c }}>{statusMap.t}</span>}
      </div>
      {view.band && (
        <div className="relative h-2 rounded-full bg-white/[0.06] mt-1.5 overflow-hidden">
          <div className="absolute top-0 bottom-0" style={{ left: `${bandPos(view.band.low, view.band, true)}%`, right: `${100 - bandPos(view.band.high, view.band, false)}%`, background: "rgba(61,255,181,0.25)" }} />
          {hr != null && <div className="absolute top-1/2 -translate-y-1/2 w-1 h-3.5 rounded-full" style={{ left: `calc(${hrPos(hr, view.band)}% - 2px)`, background: statusMap.c }} />}
        </div>
      )}
    </div>
  );
}

function hrPos(hr: number, band: { low: number; high: number }) {
  const span = band.high - band.low || 1;
  const lo = band.low - span * 0.6;
  const hi = band.high + span * 0.6;
  return Math.max(0, Math.min(100, ((hr - lo) / (hi - lo)) * 100));
}
function bandPos(v: number, band: { low: number; high: number }, _left: boolean) {
  const span = band.high - band.low || 1;
  const lo = band.low - span * 0.6;
  const hi = band.high + span * 0.6;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

function MiniRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-[var(--color-ink-faint)] tracking-wide">{label}</span>
      {value}
    </div>
  );
}
