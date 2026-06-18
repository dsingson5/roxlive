/**
 * Canvas renderer for the Picture-in-Picture mini window. Pure 2D drawing — no
 * CSS vars are available on a canvas, so colours are explicit hex.
 */

export const ZONE_HEX = ["#6b87a8", "#38b6ff", "#3dffb5", "#ffb02e", "#ff4d6b"];
const BG = "#0b0d11";
const INK = "#f2f4f6";
const DIM = "#9aa3b2";
const FAINT = "#5d6675";
const VOLT = "#d8ff3a";

export interface PipFrame {
  title: string;
  mode: "solo" | "squad";
  // solo
  hr?: number | null;
  zoneColor?: string;
  pctMax?: number | null;
  clock?: string; // elapsed session time (mm:ss)
  line1?: string; // interval name / status
  line2?: string; // countdown / target
  status?: string; // ON TARGET / etc.
  statusColor?: string;
  paused?: boolean;
  // squad
  athletes?: { name: string; hr: number | null; color: string; sub: string; paused?: boolean }[];
}

export function paintFrame(ctx: CanvasRenderingContext2D, w: number, h: number, f: PipFrame) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // header
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = VOLT;
  ctx.font = "700 22px 'Space Grotesk', system-ui, sans-serif";
  ctx.fillText("ROX", 24, 42);
  ctx.fillStyle = INK;
  ctx.fillText("LIVE", 24 + ctx.measureText("ROX").width, 42);
  ctx.fillStyle = FAINT;
  ctx.font = "600 13px 'Inter', system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText((f.title || "").slice(0, 40), w - 24, 42);
  ctx.textAlign = "left";

  if (f.mode === "squad") return paintSquad(ctx, w, h, f);

  // ----- solo -----
  const color = f.zoneColor || FAINT;
  // big HR
  ctx.fillStyle = color;
  ctx.font = "700 132px 'Space Grotesk', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const hrText = f.hr != null ? String(Math.round(f.hr)) : "—";
  ctx.fillText(hrText, 24, h / 2 + 14);
  const hrW = ctx.measureText(hrText).width;
  ctx.fillStyle = FAINT;
  ctx.font = "600 18px 'Inter', system-ui, sans-serif";
  ctx.fillText("BPM", 30 + hrW, h / 2 + 44);
  if (f.pctMax != null) {
    ctx.fillStyle = color;
    ctx.font = "600 20px 'JetBrains Mono', monospace";
    ctx.fillText(`${Math.round(f.pctMax)}%`, 30 + hrW, h / 2 - 24);
  }

  // bottom-left: elapsed session time (always shown)
  if (f.clock) {
    ctx.fillStyle = DIM;
    ctx.font = "600 13px 'Inter', system-ui, sans-serif";
    ctx.fillText("TIME", 24, h - 46);
    ctx.fillStyle = f.paused ? VOLT : INK;
    ctx.font = "700 34px 'JetBrains Mono', monospace";
    ctx.fillText(f.clock, 24, h - 14);
  }

  // right column: interval + countdown + status
  const rx = w - 24;
  ctx.textAlign = "right";
  if (f.line1) {
    ctx.fillStyle = INK;
    ctx.font = "600 26px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText(f.line1.slice(0, 18), rx, 110);
  }
  if (f.line2) {
    ctx.fillStyle = f.paused ? VOLT : DIM;
    ctx.font = "700 64px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText(f.line2, rx, 180);
  }
  if (f.paused) {
    ctx.fillStyle = VOLT;
    ctx.font = "700 24px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText("PAUSED", rx, 240);
  } else if (f.status) {
    ctx.fillStyle = f.statusColor || DIM;
    ctx.font = "700 22px 'Inter', system-ui, sans-serif";
    ctx.fillText(f.status, rx, 240);
  }
  ctx.textAlign = "left";
}

function paintSquad(ctx: CanvasRenderingContext2D, w: number, h: number, f: PipFrame) {
  const list = (f.athletes || []).slice(0, 5);
  if (list.length === 0) {
    ctx.fillStyle = FAINT;
    ctx.font = "600 22px 'Inter', system-ui, sans-serif";
    ctx.fillText("No athletes running", 24, h / 2);
    return;
  }
  const top = 70;
  const rowH = Math.min(56, (h - top - 16) / list.length);
  list.forEach((a, i) => {
    const y = top + i * rowH;
    // color dot
    ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.arc(34, y + rowH / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    // name
    ctx.fillStyle = INK;
    ctx.font = "600 22px 'Space Grotesk', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(a.name.slice(0, 14), 52, y + rowH / 2);
    // sub (countdown / target)
    ctx.fillStyle = a.paused ? VOLT : FAINT;
    ctx.font = "500 14px 'JetBrains Mono', monospace";
    ctx.fillText(a.paused ? "PAUSED" : a.sub.slice(0, 22), 52, y + rowH / 2 + 20);
    // HR (right)
    ctx.textAlign = "right";
    ctx.fillStyle = a.color;
    ctx.font = "700 40px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillText(a.hr != null ? String(Math.round(a.hr)) : "—", w - 24, y + rowH / 2);
    ctx.textAlign = "left";
  });
}
