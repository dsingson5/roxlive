import { AnimatePresence, motion } from "motion/react";
import type { PlannedSegment, AthleteProfile } from "../types";
import { runTarget } from "../data/hyrox";

export function StationGuide({
  seg,
  profile,
  isCurrent,
}: {
  seg: PlannedSegment;
  profile: AthleteProfile;
  isCurrent: boolean;
}) {
  const isRun = seg.kind === "run";
  return (
    <div className="card p-5 h-full flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <span className="card-title">{isCurrent ? "Now · Coaching" : "Coaching"}</span>
        {isCurrent && (
          <span className="flex items-center gap-1.5 text-[10px] mono text-[var(--color-volt)]">
            <span className="live-dot w-1.5 h-1.5 rounded-full bg-[var(--color-volt)]" /> LIVE
          </span>
        )}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={seg.index}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          className="flex-1 flex flex-col"
        >
          {isRun ? (
            <RunGuide profile={profile} />
          ) : (
            <StationDetail seg={seg} profile={profile} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function RunGuide({ profile }: { profile: AthleteProfile }) {
  return (
    <>
      <div className="flex items-baseline gap-3">
        <h3 className="font-[var(--font-display)] text-2xl font-semibold text-[var(--color-cyan)]">Compromised Run</h3>
        <span className="mono text-xs text-[var(--color-ink-faint)]">1 km · ◷ {runTarget(profile.division)}</span>
      </div>
      <p className="text-sm text-[var(--color-ink-dim)] mt-2 leading-relaxed">
        Settle into a sustainable rhythm immediately — the first 100 m off every station will feel heavy.
        Relax the upper body, drop the shoulders, and breathe to a cadence. Negative-split the back half if you can.
      </p>
      <Section title="Cues" items={["Quick feet, short ground contact", "Nose-in / mouth-out breathing rhythm", "Run the tangents, save every metre", "Build pace as legs come back"]} color="var(--color-cyan)" />
      <Section title="Avoid" items={["Sprinting out of the station", "Holding tension in arms & shoulders"]} color="var(--color-amber)" />
    </>
  );
}

function StationDetail({ seg, profile }: { seg: PlannedSegment; profile: AthleteProfile }) {
  const st = seg.station!;
  const g = st.guide;
  const load = profile.division === "pro" ? st.load.pro : st.load.open;
  const target = profile.division === "pro" ? g.target.pro : g.target.open;
  return (
    <>
      <div className="flex items-baseline gap-3 flex-wrap">
        <h3 className="font-[var(--font-display)] text-2xl font-semibold text-[var(--color-volt)]">{st.name}</h3>
        <span className="mono text-xs text-[var(--color-ink-faint)]">{load} · ◷ {target}</span>
      </div>
      <p className="text-sm text-[var(--color-ink-dim)] mt-2 leading-relaxed">{g.pacing}</p>
      <Section title="Technique" items={g.technique} color="var(--color-volt)" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5">
        <Section title="Avoid" items={g.mistakes} color="var(--color-amber)" />
        <Section title="Transition out" items={[g.exit]} color="var(--color-mint)" />
      </div>
    </>
  );
}

function Section({ title, items, color }: { title: string; items: string[]; color: string }) {
  return (
    <div className="mt-4">
      <div className="text-[10px] tracking-[0.18em] uppercase mb-1.5" style={{ color }}>{title}</div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-[var(--color-ink-dim)] leading-snug">
            <span className="mt-[6px] w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
