import { useEffect, useMemo, useRef, useState } from "react";
import type { SeriesPoint, ZoneBounds } from "../types";
import { ZONE_DEFS } from "../lib/zones";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Metric = "hr" | "alpha1" | "brpm";

export function LiveChart({
  series,
  bounds,
  maxHr,
  windowSec = 240,
}: {
  series: SeriesPoint[];
  bounds: ZoneBounds;
  maxHr: number;
  windowSec?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [show, setShow] = useState<Record<Metric, boolean>>({ hr: true, alpha1: true, brpm: true });
  const height = 280;
  const padL = 38;
  const padR = 40;
  const padT = 14;
  const padB = 22;

  const view = useMemo(() => {
    if (series.length === 0) return null;
    const tEnd = series[series.length - 1].t;
    const tStart = tEnd - windowSec * 1000;
    const pts = series.filter((p) => p.t >= tStart);
    if (pts.length < 2) return null;

    const x = (t: number) => padL + ((t - tStart) / (tEnd - tStart || 1)) * (width - padL - padR);

    // HR scale
    const hrMinAxis = 90;
    const hrMaxAxis = Math.max(maxHr + 5, 180);
    const yHr = (v: number) =>
      padT + (1 - (v - hrMinAxis) / (hrMaxAxis - hrMinAxis)) * (height - padT - padB);

    // alpha scale 0..1.5
    const aMax = 1.5;
    const yA = (v: number) => padT + (1 - v / aMax) * (height - padT - padB);

    // brpm scale 0..60
    const yB = (v: number) => padT + (1 - v / 60) * (height - padT - padB);

    const line = (sel: (p: SeriesPoint) => number | null, y: (v: number) => number) => {
      let d = "";
      let started = false;
      for (const p of pts) {
        const v = sel(p);
        if (v === null || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        d += `${started ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        started = true;
      }
      return d;
    };

    return {
      pts,
      x,
      yHr,
      yA,
      yB,
      hrMinAxis,
      hrMaxAxis,
      hrPath: line((p) => p.hr, yHr),
      aPath: line((p) => p.alpha1, yA),
      bPath: line((p) => p.brpm, yB),
      lastHr: pts[pts.length - 1].hr,
    };
  }, [series, width, maxHr, windowSec]);

  const zoneBandRects = useMemo(() => {
    if (!view) return [];
    const tops = [bounds[0], bounds[1], bounds[2], bounds[3], view.hrMaxAxis];
    let lo = view.hrMinAxis;
    const rects: { y: number; h: number; color: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const hi = Math.min(tops[i], view.hrMaxAxis);
      if (hi <= lo) {
        continue;
      }
      const yTop = view.yHr(hi);
      const yBot = view.yHr(lo);
      rects.push({ y: yTop, h: yBot - yTop, color: ZONE_DEFS[i].color });
      lo = hi;
    }
    return rects;
  }, [view, bounds]);

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="card-title">Live Telemetry</span>
          <span className="live-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-red)]" />
        </div>
        <div className="flex items-center gap-1.5">
          <Toggle label="HR" color="var(--color-ink)" on={show.hr} onClick={() => setShow((s) => ({ ...s, hr: !s.hr }))} />
          <Toggle label="α1" color="var(--color-cyan)" on={show.alpha1} onClick={() => setShow((s) => ({ ...s, alpha1: !s.alpha1 }))} />
          <Toggle label="Breath" color="var(--color-mint)" on={show.brpm} onClick={() => setShow((s) => ({ ...s, brpm: !s.brpm }))} />
        </div>
      </div>

      <div ref={ref} className="w-full" style={{ height }}>
        {view ? (
          <svg width={width} height={height} className="block">
            {/* zone bands */}
            {zoneBandRects.map((r, i) => (
              <rect key={i} x={padL} y={r.y} width={width - padL - padR} height={r.h} fill={r.color} opacity={0.07} />
            ))}
            {/* zone boundary HR labels */}
            {[bounds[0], bounds[1], bounds[2], bounds[3]].map((b, i) => (
              <g key={i}>
                <line x1={padL} x2={width - padR} y1={view.yHr(b)} y2={view.yHr(b)} stroke="rgba(255,255,255,0.05)" />
                <text x={4} y={view.yHr(b) + 3} fontSize="9" fill="var(--color-ink-faint)" className="mono">
                  {b}
                </text>
              </g>
            ))}

            {/* alpha threshold lines */}
            {show.alpha1 && (
              <>
                <ThreshLine y={view.yA(0.75)} label="LT1 0.75" x2={width - padR} />
                <ThreshLine y={view.yA(0.5)} label="LT2 0.50" x2={width - padR} />
                <text x={width - padR + 4} y={view.yA(1.5) + 8} fontSize="9" fill="var(--color-cyan)" className="mono">1.5</text>
                <text x={width - padR + 4} y={view.yA(0) } fontSize="9" fill="var(--color-cyan)" className="mono">α1</text>
              </>
            )}

            {/* breathing line */}
            {show.brpm && view.bPath && (
              <path d={view.bPath} fill="none" stroke="var(--color-mint)" strokeWidth={1.6} opacity={0.85} strokeDasharray="1 3" strokeLinecap="round" />
            )}
            {/* alpha line */}
            {show.alpha1 && view.aPath && (
              <path d={view.aPath} fill="none" stroke="var(--color-cyan)" strokeWidth={2} opacity={0.95} strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 5px rgba(56,225,255,0.5))" }} />
            )}
            {/* HR line */}
            {show.hr && view.hrPath && (
              <path d={view.hrPath} fill="none" stroke="var(--color-ink)" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" style={{ filter: "drop-shadow(0 0 6px rgba(255,255,255,0.25))" }} />
            )}
            {/* current HR dot */}
            {show.hr && view.lastHr !== null && (
              <circle cx={width - padR} cy={view.yHr(view.lastHr)} r={3.5} fill="var(--color-volt)" style={{ filter: "drop-shadow(0 0 6px var(--color-volt))" }} />
            )}
          </svg>
        ) : (
          <div className="h-full grid place-items-center text-[var(--color-ink-faint)] text-sm">
            Waiting for the first beats…
          </div>
        )}
      </div>
    </div>
  );
}

function ThreshLine({ y, label, x2 }: { y: number; label: string; x2: number }) {
  return (
    <g>
      <line x1={38} x2={x2} y1={y} y2={y} stroke="var(--color-cyan)" strokeWidth={1} strokeDasharray="4 4" opacity={0.4} />
      <text x={42} y={y - 3} fontSize="8.5" fill="var(--color-cyan)" className="mono" opacity={0.8}>
        {label}
      </text>
    </g>
  );
}

function Toggle({ label, color, on, onClick }: { label: string; color: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded-md text-[10px] font-semibold tracking-wide transition-all"
      style={{
        color: on ? color : "var(--color-ink-faint)",
        background: on ? "rgba(255,255,255,0.06)" : "transparent",
        border: `1px solid ${on ? "rgba(255,255,255,0.14)" : "transparent"}`,
      }}
    >
      <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: on ? color : "var(--color-ink-faint)" }} />
      {label}
    </button>
  );
}
