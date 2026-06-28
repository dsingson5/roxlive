/**
 * Hands-free voice commands for the strength runner (Web Speech recognition).
 *
 * The athlete can say "done" / "rest" / "next" to advance (end a set or skip the
 * rest) or "stop workout" to finish — useful mid-lift when tapping is awkward.
 * Recognition support is patchy (Chrome/Edge desktop + Android good; Firefox
 * none; iOS Safari/Bluefy unreliable), so this is strictly OPT-IN and the
 * on-screen End/Skip buttons + auto-cycling remain the universal path. The hook
 * is best-effort: it never throws, surfaces a short error string, and the caller
 * decides what to do per command based on the current phase.
 *
 * It listens continuously and restarts itself when the engine ends on a silence
 * timeout — but a fatal error (mic permission denied) or a rapid restart storm
 * permanently stops the auto-restart so a denied mic can't busy-loop the engine.
 */
import { useEffect, useRef, useState } from "react";

export type VoiceCommand = "advance" | "stop";

interface ResultItem {
  isFinal: boolean;
  0?: { transcript: string };
}
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ResultItem> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => RecognitionLike;
interface SpeechWindow {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
}

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechCommandsSupported(): boolean {
  return getCtor() != null;
}

const ADVANCE = /\b(done|next|rest|skip|finished|finish|that'?s it|next set)\b/i;
const STOP = /\b(stop workout|end workout|stop the workout|finish workout|quit)\b/i;

/**
 * Listen for voice commands while `enabled`. Returns whether recognition is
 * supported and the latest (transient) error, if any. Only FINAL results are
 * acted on (interim results would match the same phrase several times), with a
 * short time guard so one utterance can't fire twice across a phase change.
 */
export function useSpeechCommands(enabled: boolean, onCommand: (c: VoiceCommand) => void): { supported: boolean; error: string | null } {
  const supported = speechCommandsSupported();
  const [error, setError] = useState<string | null>(null);
  const cbRef = useRef(onCommand);
  useEffect(() => { cbRef.current = onCommand; }, [onCommand]);
  const lastFireRef = useRef(0);

  useEffect(() => {
    if (!enabled || !supported) { setError(null); return; } // clear any stale banner when disabled
    const Ctor = getCtor();
    if (!Ctor) return;
    let stopped = false; // set on cleanup (disable/unmount)
    let fatal = false; // permanent stop (permission denied / restart storm)
    let lastStart = 0;
    let rapid = 0;
    let rec: RecognitionLike;
    try {
      rec = new Ctor();
    } catch {
      setError("Voice commands unavailable on this browser.");
      return;
    }
    rec.continuous = true;
    rec.interimResults = false; // FINAL results only → one match per utterance
    rec.lang = "en-US";

    const safeStart = () => { lastStart = Date.now(); try { rec.start(); } catch { /* already running */ } };

    rec.onresult = (e) => {
      const now = Date.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res?.isFinal) continue;
        const t = (res[0]?.transcript || "").toLowerCase();
        if (now - lastFireRef.current < 900) continue;
        if (STOP.test(t)) { lastFireRef.current = now; cbRef.current("stop"); return; }
        if (ADVANCE.test(t)) { lastFireRef.current = now; cbRef.current("advance"); return; }
      }
    };
    rec.onerror = (e) => {
      const err = e?.error || "";
      if (err === "not-allowed" || err === "service-not-allowed") { fatal = true; setError("Mic permission denied — using the buttons."); }
      else if (err && err !== "no-speech" && err !== "aborted" && err !== "network") setError(`Voice: ${err}`);
    };
    rec.onend = () => {
      if (stopped || fatal) return;
      // a near-instant end means start() is failing in a loop — back off after a few
      if (Date.now() - lastStart < 400) { if (++rapid >= 6) { fatal = true; setError("Voice recognition keeps stopping — using the buttons."); return; } }
      else rapid = 0;
      safeStart();
    };
    lastStart = Date.now();
    try { rec.start(); setError(null); } catch { /* already started */ }

    return () => {
      stopped = true;
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* */ }
    };
  }, [enabled, supported]);

  return { supported, error };
}
