import { motion } from "motion/react";
import type { PlannedSegment, SegmentRecord, AthleteProfile } from "../types";
import { runTarget } from "../data/hyrox";

export function RaceRail({
  segments,
  currentIndex,
  focusIndex,
  records,
  profile,
  onFocus,
}: {
  segments: PlannedSegment[];
  currentIndex: number;
  focusIndex: number;
  records: Record<number, SegmentRecord>;
  profile: AthleteProfile;
  onFocus: (i: number) => void;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="card-title">HYROX Race · 8 Runs · 8 Stations</div>
        <div className="text-[10px] mono text-[var(--color-ink-faint)]">
          {Math.min(currentIndex + 1, segments.length)}/{segments.length}
        </div>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
        {segments.map((seg) => {
          const done = seg.index < currentIndex;
          const active = seg.index === currentIndex;
          const focused = seg.index === focusIndex;
          const isRun = seg.kind === "run";
          const rec = records[seg.index];
          const target = isRun ? runTarget(profile.division) : profile.division === "pro" ? seg.station!.guide.target.pro : seg.station!.guide.target.open;
          return (
            <button
              key={seg.index}
              onClick={() => onFocus(seg.index)}
              className="shrink-0 rounded-xl px-2.5 py-2 text-left transition-all relative"
              style={{
                width: isRun ? 64 : 78,
                background: active ? "rgba(216,255,58,0.1)" : focused ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${active ? "var(--color-volt)" : focused ? "rgba(255,255,255,0.2)" : "var(--color-line)"}`,
                opacity: done ? 0.55 : 1,
              }}
            >
              {active && (
                <motion.span layoutId="rail-cursor" className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-[var(--color-volt)]" style={{ boxShadow: "0 0 8px var(--color-volt)" }} />
              )}
              <div className="text-[9px] mono tracking-wider" style={{ color: isRun ? "var(--color-cyan)" : active ? "var(--color-volt)" : "var(--color-ink-faint)" }}>
                {isRun ? "RUN" : seg.station!.short}
              </div>
              <div className="num text-[11px] mt-0.5 truncate" style={{ color: "var(--color-ink)" }}>
                {isRun ? "1 km" : seg.station!.name.split(" ")[0]}
              </div>
              <div className="mono text-[9px] mt-0.5" style={{ color: done && rec?.avgHr ? "var(--color-mint)" : "var(--color-ink-faint)" }}>
                {done && rec?.avgHr ? `♥ ${Math.round(rec.avgHr)}` : `◷ ${target}`}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
