import { motion } from "motion/react";
import type { MetricsSnapshot, AthleteProfile } from "../types";
import { RadialGauge } from "./Charts";
import { ZONE_DEFS } from "../lib/zones";
import { alphaBand } from "../lib/dfa";
import { fmtNum } from "../lib/format";

export function HeroHR({ snap, profile }: { snap: MetricsSnapshot; profile: AthleteProfile }) {
  const hr = snap.hr;
  const zone = snap.zone ?? 1;
  const zoneDef = ZONE_DEFS[zone - 1];
  const color = hr === null ? "var(--color-ink-faint)" : zoneDef.color;
  const ringDur = hr && hr > 0 ? 60 / hr : 1;

  return (
    <div className="card p-5 flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute top-4 left-5 card-title">Heart Rate</div>
      <div className="absolute top-4 right-5 flex items-center gap-1.5 text-[10px] mono text-[var(--color-ink-faint)]">
        <span style={{ color }}>{zoneDef.name}</span>
      </div>

      <RadialGauge
        value={hr}
        min={profile.restHr}
        max={profile.maxHr}
        size={232}
        thickness={13}
        color={color}
        ticks={[
          { at: snap.zoneBounds[1], color: "rgba(255,255,255,0.25)" },
          { at: snap.zoneBounds[3], color: "rgba(255,255,255,0.25)" },
        ]}
      >
        <div className="flex flex-col items-center -mt-1">
          {/* pulse ring */}
          <div className="relative h-3 mb-1">
            {hr !== null && (
              <>
                <span
                  className="hr-ring absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ width: 26, height: 26, background: color, animationDuration: `${ringDur}s`, opacity: 0.5 }}
                />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: 9, height: 9, background: color, boxShadow: `0 0 12px ${color}` }} />
              </>
            )}
          </div>
          <div className="num leading-none" style={{ fontSize: 72, color: "var(--color-ink)" }}>
            {hr !== null ? Math.round(hr) : "—"}
          </div>
          <div className="num text-[var(--color-ink-faint)] text-xs tracking-[0.25em] mt-1">BPM</div>
          <div className="mono text-[11px] mt-2" style={{ color }}>
            {snap.pctMax !== null ? `${Math.round(snap.pctMax)}% MAX · Z${zone}` : "—"}
          </div>
        </div>
      </RadialGauge>

      <div className={`grid ${snap.bodyTempC != null ? "grid-cols-4" : "grid-cols-3"} gap-2 w-full mt-3`}>
        <MiniStat label="AVG" value={fmtNum(snap.hrAvg)} />
        <MiniStat label="MAX" value={fmtNum(snap.hrMax)} />
        <MiniStat label="KCAL" value={fmtNum(snap.kcal)} />
        {snap.bodyTempC != null && (
          <MiniStat label="°C TEMP" value={snap.bodyTempC.toFixed(1)} accent="var(--color-amber)" />
        )}
      </div>
    </div>
  );
}

export function DfaGauge({ snap }: { snap: MetricsSnapshot }) {
  const a = snap.dfa.alpha1;
  const band = alphaBand(a);
  const reliable = snap.dfa.reliable;

  return (
    <div className="card p-5 flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute top-4 left-5 card-title">DFA · α1</div>
      <div className="absolute top-4 right-5">
        <ReliabilityChip reliable={reliable} beats={snap.dfa.beats} />
      </div>

      <RadialGauge
        value={a === null ? null : a}
        min={0.2}
        max={1.5}
        size={232}
        thickness={13}
        color={band.color}
        ticks={[
          { at: 0.5, color: "var(--color-amber)" },
          { at: 0.75, color: "var(--color-z3)" },
        ]}
      >
        <div className="flex flex-col items-center">
          <motion.div
            key={band.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="num leading-none"
            style={{ fontSize: 66, color: "var(--color-ink)" }}
          >
            {a !== null ? a.toFixed(2) : "—"}
          </motion.div>
          <div className="mt-2 px-3 py-1 rounded-full text-[11px] font-semibold tracking-wide" style={{ color: band.color, background: "rgba(255,255,255,0.05)", border: `1px solid ${band.color}` }}>
            {band.label}
          </div>
          <div className="text-[10px] text-[var(--color-ink-faint)] mt-2 text-center max-w-[150px]">{band.domain}</div>
        </div>
      </RadialGauge>

      <div className="grid grid-cols-2 gap-2 w-full mt-3">
        <MiniStat label="ARTIFACTS" value={`${snap.dfa.artifactPct.toFixed(1)}%`} accent={snap.dfa.artifactPct > 5 ? "var(--color-amber)" : undefined} />
        <MiniStat label="BEATS" value={String(snap.dfa.beats)} />
      </div>
    </div>
  );
}

function ReliabilityChip({ reliable, beats }: { reliable: boolean; beats: number }) {
  const warming = beats < 64;
  const color = warming ? "var(--color-ink-faint)" : reliable ? "var(--color-mint)" : "var(--color-amber)";
  const label = warming ? "WARMING" : reliable ? "RELIABLE" : "NOISY";
  return (
    <span className="flex items-center gap-1 text-[10px] mono" style={{ color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export function MiniStat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] border border-[var(--color-line)] px-2 py-1.5 text-center">
      <div className="num text-base" style={{ color: accent ?? "var(--color-ink)" }}>{value}</div>
      <div className="text-[9px] tracking-[0.15em] text-[var(--color-ink-faint)] mt-0.5">{label}</div>
    </div>
  );
}
