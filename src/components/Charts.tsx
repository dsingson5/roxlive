/**
 * Lightweight, dependency-free SVG chart primitives tuned for streaming data.
 * Crisp on hi-DPI, theme-aware (via CSS vars), and cheap enough to redraw at 1 Hz.
 */
import { useMemo } from "react";

/* ---------- Sparkline (inline, for stat cards) ---------- */
export function Sparkline({
  data,
  color = "var(--color-volt)",
  width = 120,
  height = 34,
  strokeWidth = 2,
  fill = true,
}: {
  data: (number | null)[];
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  fill?: boolean;
}) {
  const { path, area } = useMemo(() => {
    const pts = data.map((v, i) => ({ v, i })).filter((p) => p.v !== null) as {
      v: number;
      i: number;
    }[];
    if (pts.length < 2) return { path: "", area: "" };
    const xs = data.length - 1 || 1;
    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    const range = max - min || 1;
    const pad = 3;
    const sx = (i: number) => pad + (i / xs) * (width - pad * 2);
    const sy = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
    let d = "";
    pts.forEach((p, idx) => {
      d += `${idx === 0 ? "M" : "L"}${sx(p.i).toFixed(1)},${sy(p.v).toFixed(1)}`;
    });
    const first = pts[0];
    const last = pts[pts.length - 1];
    const a = `${d}L${sx(last.i).toFixed(1)},${height}L${sx(first.i).toFixed(1)},${height}Z`;
    return { path: d, area: a };
  }, [data, width, height]);

  if (!path) return <svg width={width} height={height} />;
  const gid = `sl-${color.replace(/[^a-z]/gi, "")}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Radial gauge arc ---------- */
export function RadialGauge({
  value,
  min,
  max,
  size = 220,
  thickness = 14,
  trackColor = "rgba(255,255,255,0.08)",
  color = "var(--color-volt)",
  startAngle = 135,
  sweep = 270,
  children,
  ticks,
}: {
  value: number | null;
  min: number;
  max: number;
  size?: number;
  thickness?: number;
  trackColor?: string;
  color?: string;
  startAngle?: number;
  sweep?: number;
  children?: React.ReactNode;
  ticks?: { at: number; color: string; label?: string }[];
}) {
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const frac = value === null ? 0 : clamp01((value - min) / (max - min));

  const polar = (angleDeg: number) => {
    const a = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const arcPath = (fromFrac: number, toFrac: number) => {
    const a0 = startAngle + sweep * fromFrac;
    const a1 = startAngle + sweep * toFrac;
    const p0 = polar(a0);
    const p1 = polar(a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${r},${r} 0 ${large} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
  };

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="block">
        <path d={arcPath(0, 1)} fill="none" stroke={trackColor} strokeWidth={thickness} strokeLinecap="round" />
        {frac > 0.001 && (
          <path
            d={arcPath(0, frac)}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 8px ${color})`, transition: "stroke 0.4s ease" }}
          />
        )}
        {ticks?.map((tk, i) => {
          const f = clamp01((tk.at - min) / (max - min));
          const a = startAngle + sweep * f;
          const outer = polarPt(cx, cy, r + thickness / 2 + 2, a);
          const inner = polarPt(cx, cy, r - thickness / 2 - 2, a);
          return (
            <line
              key={i}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={tk.color}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.9}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

function polarPt(cx: number, cy: number, r: number, angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
