export function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function fmtPace(secPerKm: number | null): string {
  if (secPerKm === null || !Number.isFinite(secPerKm)) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

export function fmtNum(v: number | null, digits = 0): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

export function fmtSigned(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
