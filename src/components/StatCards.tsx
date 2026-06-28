import { motion } from "motion/react";
import type { MetricsSnapshot, SeriesPoint } from "../types";
import { Sparkline } from "./Charts";
import { ZONE_DEFS } from "../lib/zones";
import { alphaBand } from "../lib/dfa";
import { fmtClock, fmtDist, fmtNum, fmtPace, fmtSigned } from "../lib/format";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card p-4 flex flex-col ${className}`}>
      <div className="card-title mb-2">{title}</div>
      {children}
    </div>
  );
}

/* ---- Aerobic decoupling ---- */
export function DecouplingCard({ snap }: { snap: MetricsSnapshot }) {
  const d = snap.decoupling;
  const pct = d.pct;
  const good = pct !== null && pct < 5;
  const color = pct === null ? "var(--color-ink-faint)" : good ? "var(--color-mint)" : pct < 10 ? "var(--color-amber)" : "var(--color-red)";
  return (
    <Card title="Aerobic Decoupling">
      <div className="flex items-end justify-between">
        <div className="num text-4xl" style={{ color }}>{pct === null ? "—" : fmtSigned(pct, 1)}<span className="text-lg text-[var(--color-ink-faint)]">%</span></div>
        <div className="text-[10px] mono text-[var(--color-ink-faint)] text-right">
          {d.mode === "speed" ? "Pa:HR" : "HR-drift"}
          <br />
          {d.ready ? "warm-up excl." : "building…"}
        </div>
      </div>
      <div className="mt-2 text-[11px] text-[var(--color-ink-dim)]">
        {pct === null
          ? "Needs sustained work to compute drift."
          : good
            ? "Well-coupled — strong aerobic durability."
            : pct < 10
              ? "Moderate drift — fatigue or heat creeping in."
              : "High drift — pace is unsustainable."}
      </div>
    </Card>
  );
}

/* ---- HRV (RMSSD / SDNN) ---- */
export function HrvCard({ snap, series }: { snap: MetricsSnapshot; series: SeriesPoint[] }) {
  const { rmssd, sdnn } = snap.hrv;
  return (
    <Card title="HRV · Vagal Tone">
      <div className="flex items-end justify-between">
        <div>
          <div className="num text-4xl text-[var(--color-cyan)]">{fmtNum(rmssd)}<span className="text-base text-[var(--color-ink-faint)] ml-1">ms</span></div>
          <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)] mt-0.5">RMSSD</div>
        </div>
        <div className="text-right">
          <div className="num text-xl text-[var(--color-ink-dim)]">{fmtNum(sdnn)}</div>
          <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)]">SDNN</div>
        </div>
      </div>
      <div className="mt-2">
        <Sparkline data={series.slice(-90).map((p) => p.alpha1)} color="var(--color-cyan)" width={260} height={30} />
      </div>
    </Card>
  );
}

/* ---- Breathing orb (RSA-derived respiration) ---- */
export function BreathingCard({ snap }: { snap: MetricsSnapshot }) {
  const brpm = snap.respiration.brpm;
  const conf = snap.respiration.confidence;
  const cycle = brpm && brpm > 0 ? 60 / brpm : 3;
  const weak = conf < 0.18;
  return (
    <Card title="Breathing · RSA">
      <div className="flex items-center gap-4">
        <div className="relative grid place-items-center" style={{ width: 76, height: 76 }}>
          <motion.span
            className="absolute rounded-full"
            style={{ background: "radial-gradient(circle, rgba(61,255,181,0.5), rgba(61,255,181,0.05))" }}
            animate={{ scale: brpm ? [0.55, 1, 0.55] : 0.7, opacity: brpm ? [0.5, 0.95, 0.5] : 0.3 }}
            transition={{ duration: cycle, repeat: Infinity, ease: "easeInOut" }}
            initial={false}
          />
          <span className="absolute w-[76px] h-[76px] rounded-full border border-[var(--color-mint)]/20" />
          <div className="num text-2xl text-[var(--color-mint)] z-10">{brpm ? Math.round(brpm) : "—"}</div>
        </div>
        <div>
          <div className="text-[11px] tracking-[0.15em] text-[var(--color-ink-faint)]">BREATHS / MIN</div>
          <div className="text-[11px] text-[var(--color-ink-dim)] mt-1 max-w-[150px]">
            {brpm === null ? "Deriving from R-R oscillation…" : weak ? "Weak RSA signal at this intensity." : "Estimated from heart-rate variability."}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---- Interval / work-rest ---- */
export function IntervalCard({ snap }: { snap: MetricsSnapshot }) {
  const st = snap.intervalState;
  const color = st === "work" ? "var(--color-volt)" : st === "rest" ? "var(--color-z2)" : "var(--color-ink-faint)";
  const label = st === "work" ? "WORK" : st === "rest" ? "REST" : "READY";
  return (
    <Card title="Interval Engine">
      <div className="flex items-end justify-between">
        <div>
          <motion.div key={st} initial={{ scale: 0.9, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} className="num text-3xl" style={{ color }}>{label}</motion.div>
          <div className="mono text-[11px] text-[var(--color-ink-faint)] mt-1">{fmtClock(snap.stateElapsedSec)} in state</div>
        </div>
        <div className="text-right">
          <div className="num text-3xl text-[var(--color-ink)]">{snap.intervalCount}</div>
          <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)]">REPS</div>
        </div>
      </div>
    </Card>
  );
}

/* ---- Pace / cadence / distance ---- */
export function PaceCard({ snap }: { snap: MetricsSnapshot }) {
  const hasCadence = snap.cadence != null;
  return (
    <Card title={hasCadence ? "Pace · Cadence" : "Pace · Distance"}>
      <div className="flex items-end justify-between">
        <div>
          <div className="num text-3xl text-[var(--color-ink)]">{fmtPace(snap.paceSecPerKm)}<span className="text-sm text-[var(--color-ink-faint)] ml-1">/km</span></div>
          <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)] mt-0.5">CURRENT PACE</div>
        </div>
        <div className="text-right">
          {hasCadence ? (
            <>
              <div className="num text-2xl text-[var(--color-cyan)]">{Math.round(snap.cadence as number)}<span className="text-xs text-[var(--color-ink-faint)] ml-1">spm</span></div>
              <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)]">CADENCE</div>
            </>
          ) : (
            <>
              <div className="num text-2xl text-[var(--color-volt)]">{fmtDist(snap.distanceM)}</div>
              <div className="text-[10px] tracking-[0.15em] text-[var(--color-ink-faint)]">DISTANCE</div>
            </>
          )}
        </div>
      </div>
      {hasCadence && (
        <div className="mt-2 pt-2 border-t border-[var(--color-line)] flex items-center justify-between text-[11px]">
          <span className="text-[var(--color-ink-faint)] tracking-[0.12em]">DISTANCE</span>
          <span className="num text-[var(--color-volt)]">{fmtDist(snap.distanceM)}</span>
        </div>
      )}
    </Card>
  );
}

/* ---- Live coaching insight (free-analyzer mode) ---- */
export function InsightPanel({ snap }: { snap: MetricsSnapshot }) {
  const a = snap.dfa.alpha1;
  const band = alphaBand(a);
  const { headline, body, color } = deriveCue(snap);
  return (
    <div className="card p-5 h-full flex flex-col justify-between relative overflow-hidden">
      <div className="absolute inset-0 opacity-[0.07] pointer-events-none" style={{ background: `radial-gradient(420px 200px at 80% 0%, ${color}, transparent 70%)` }} />
      <div>
        <div className="card-title mb-3">Live Read</div>
        <motion.div key={headline} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="font-[var(--font-display)] text-2xl sm:text-3xl font-semibold leading-tight" style={{ color }}>
          {headline}
        </motion.div>
        <p className="text-sm text-[var(--color-ink-dim)] mt-2 leading-relaxed max-w-[44ch]">{body}</p>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-5">
        <Pill label="Intensity" value={band.label} color={band.color} />
        <Pill label="State" value={snap.intervalState.toUpperCase()} color={snap.intervalState === "work" ? "var(--color-volt)" : "var(--color-z2)"} />
        <Pill label="%HR Max" value={snap.pctMax != null ? `${Math.round(snap.pctMax)}%` : "—"} color="var(--color-ink)" />
      </div>
    </div>
  );
}

function Pill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] border border-[var(--color-line)] px-2 py-2 text-center">
      <div className="num text-sm truncate" style={{ color }}>{value}</div>
      <div className="text-[9px] tracking-[0.12em] text-[var(--color-ink-faint)] mt-0.5 uppercase">{label}</div>
    </div>
  );
}

function deriveCue(snap: MetricsSnapshot): { headline: string; body: string; color: string } {
  const a = snap.dfa.alpha1;
  const dec = snap.decoupling.pct;
  if (snap.hr === null) {
    return { headline: "Awaiting signal", body: "Start the demo or pair a heart-rate sensor to begin the live read.", color: "var(--color-ink-faint)" };
  }
  if (a === null) {
    return { headline: "Reading you in…", body: "Collecting beat-to-beat intervals — DFA-α1 and breathing will resolve within the first minute.", color: "var(--color-cyan)" };
  }
  if (a >= 0.85) return { headline: "Aerobic & easy", body: "You're comfortably below LT1 — ideal for base building and recovery work. You could hold this for hours.", color: "var(--color-z2)" };
  if (a >= 0.75) return { headline: "At aerobic threshold", body: "α1 ≈ 0.75 marks LT1 — the top of your easy zone. Great for long tempo and durability efforts.", color: "var(--color-z3)" };
  if (a >= 0.55) return { headline: "Working — tempo", body: `Between thresholds. Sustainable for a while but accumulating load.${dec != null && dec > 5 ? " Drift is rising — watch your pacing." : ""}`, color: "var(--color-z4)" };
  if (a >= 0.45) return { headline: "At anaerobic threshold", body: "α1 ≈ 0.5 marks LT2 — your sustainable ceiling. This is race-pace intensity; manage it carefully.", color: "var(--color-amber)" };
  return { headline: "Severe domain", body: "Above LT2 — anti-correlated dynamics. The clock is ticking on this effort; it can't last long.", color: "var(--color-z5)" };
}

/* ---- Time in zone ---- */
export function ZoneBars({ snap }: { snap: MetricsSnapshot }) {
  const total = snap.zoneTimeSec.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="card p-4">
      <div className="card-title mb-3">Time in Zone</div>
      <div className="space-y-2">
        {ZONE_DEFS.map((z, i) => {
          const sec = snap.zoneTimeSec[i];
          const pct = (sec / total) * 100;
          const active = snap.zone === z.z;
          return (
            <div key={z.z} className="flex items-center gap-3">
              <div className="w-14 text-[10px] mono shrink-0" style={{ color: z.color }}>Z{z.z} {z.name.slice(0, 4)}</div>
              <div className="flex-1 h-3.5 rounded-full bg-white/[0.04] overflow-hidden relative">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: z.color, opacity: active ? 1 : 0.65, boxShadow: active ? `0 0 10px ${z.color}` : "none" }}
                  animate={{ width: `${pct}%` }}
                  transition={{ type: "spring", stiffness: 120, damping: 20 }}
                />
              </div>
              <div className="w-12 text-right mono text-[11px] text-[var(--color-ink-dim)]">{fmtClock(sec)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
