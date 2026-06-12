import { motion } from "motion/react";
import type { DeviceInfo, MetricsSnapshot } from "../types";
import type { SourceMode } from "../hooks/useEngine";
import { fmtClock } from "../lib/format";

export function TopBar({
  snap,
  device,
  mode,
  raceMode,
  onRaceModeChange,
  onConnect,
  onDemo,
  onStop,
  onSettings,
  supported,
}: {
  snap: MetricsSnapshot;
  device: DeviceInfo | null;
  mode: SourceMode;
  raceMode: "free" | "hyrox" | "workout";
  onRaceModeChange: (m: "free" | "hyrox" | "workout") => void;
  onConnect: () => void;
  onDemo: () => void;
  onStop: () => void;
  onSettings: () => void;
  supported: boolean;
}) {
  const live = mode !== "idle";
  return (
    <header className="sticky top-0 z-30 backdrop-blur-xl bg-[var(--color-bg)]/70 border-b border-[var(--color-line)]">
      <div className="max-w-[1480px] mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
        {/* brand */}
        <div className="flex items-center gap-2.5 shrink-0">
          <Logo />
          <div className="leading-none">
            <div className="font-[var(--font-display)] font-bold text-[15px] tracking-tight">
              ROX<span className="text-[var(--color-volt)]">LIVE</span>
            </div>
            <div className="text-[9px] tracking-[0.2em] text-[var(--color-ink-faint)] mt-0.5 hidden sm:block">REAL-TIME ANALYZER</div>
          </div>
        </div>

        {/* mode segmented control */}
        <div className="hidden md:flex items-center bg-white/[0.04] rounded-xl p-0.5 border border-[var(--color-line)]">
          <ModeBtn active={raceMode === "free"} onClick={() => onRaceModeChange("free")}>Analyzer</ModeBtn>
          <ModeBtn active={raceMode === "hyrox"} onClick={() => onRaceModeChange("hyrox")}>HYROX</ModeBtn>
          <ModeBtn active={raceMode === "workout"} onClick={() => onRaceModeChange("workout")}>Workout</ModeBtn>
        </div>

        {/* session clock */}
        <div className="flex items-center gap-2 ml-1">
          {live && <span className="live-dot w-2 h-2 rounded-full bg-[var(--color-red)]" />}
          <span className="num text-xl tabular-nums" style={{ color: live ? "var(--color-ink)" : "var(--color-ink-faint)" }}>
            {fmtClock(snap.elapsedSec)}
          </span>
        </div>

        <div className="flex-1" />

        {/* device chip */}
        {device && <DeviceChip device={device} />}

        {/* actions */}
        <div className="flex items-center gap-2">
          {!live ? (
            <>
              <button onClick={onDemo} className="btn-volt px-4 h-9 text-sm flex items-center gap-1.5">
                <PlayIcon /> Demo
              </button>
              <button
                onClick={onConnect}
                className="btn-ghost px-4 h-9 text-sm flex items-center gap-1.5"
                title={supported ? "Pair a Bluetooth HR sensor" : "Web Bluetooth unavailable in this browser"}
              >
                <BtIcon /> <span className="hidden sm:inline">Connect</span>
              </button>
            </>
          ) : (
            <button onClick={onStop} className="btn-ghost px-4 h-9 text-sm flex items-center gap-1.5" style={{ borderColor: "rgba(255,77,77,0.4)", color: "var(--color-red)" }}>
              <StopIcon /> Stop
            </button>
          )}
          <button onClick={onSettings} className="btn-ghost w-9 h-9 grid place-items-center" title="Settings">
            <GearIcon />
          </button>
        </div>
      </div>
    </header>
  );
}

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="relative px-3.5 h-8 text-[13px] font-semibold rounded-lg transition-colors" style={{ color: active ? "#0b0c06" : "var(--color-ink-dim)" }}>
      {active && <motion.span layoutId="modepill" className="absolute inset-0 rounded-lg bg-[var(--color-volt)]" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
      <span className="relative">{children}</span>
    </button>
  );
}

function DeviceChip({ device }: { device: DeviceInfo }) {
  const colorMap: Record<string, string> = {
    connected: "var(--color-mint)",
    connecting: "var(--color-amber)",
    reconnecting: "var(--color-amber)",
    disconnected: "var(--color-ink-faint)",
  };
  const c = colorMap[device.status];
  return (
    <div className="hidden sm:flex items-center gap-2 px-3 h-9 rounded-xl bg-white/[0.03] border border-[var(--color-line)]">
      <span className="w-2 h-2 rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
      <div className="leading-none">
        <div className="text-[11px] font-semibold text-[var(--color-ink)] max-w-[120px] truncate">{device.name}</div>
        <div className="text-[9px] mono text-[var(--color-ink-faint)] flex items-center gap-1.5">
          <span>{device.status}</span>
          {device.hasRR && <span className="text-[var(--color-cyan)]">R-R</span>}
          {device.battery !== null && <span>· {device.battery}%</span>}
        </div>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 64 64" className="shrink-0">
      <rect width="64" height="64" rx="14" fill="#11141a" stroke="rgba(255,255,255,0.08)" />
      <path d="M8 36 H20 L25 22 L33 46 L39 30 L43 36 H56" fill="none" stroke="var(--color-volt)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="56" cy="36" r="3.5" fill="var(--color-cyan)" />
    </svg>
  );
}

const PlayIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>);
const StopIcon = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>);
const BtIcon = () => (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17" /></svg>);
const GearIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);
