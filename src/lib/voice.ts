/**
 * Voice coach — Web Speech (SpeechSynthesis) for spoken cues plus a WebAudio
 * beep for the final-seconds countdown. The user picks any installed system
 * voice (male/female/any); we add a best-effort gender label since the Web
 * Speech API doesn't expose gender metadata.
 */

import type { VoiceSettings } from "../types";

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Voices load asynchronously in some browsers; resolve once available. */
export function loadVoices(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!speechSupported()) return resolve([]);
    const initial = window.speechSynthesis.getVoices();
    if (initial.length) return resolve(initial);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    window.setTimeout(finish, timeoutMs);
  });
}

const MALE = /\b(david|mark|george|james|daniel|alex|fred|guy|liam|oliver|aaron|arthur|male|man|paul|tom|rishi|eddy|reed)\b/i;
const FEMALE = /\b(zira|hazel|susan|samantha|karen|catherine|victoria|fiona|moira|tessa|female|woman|amy|emma|joanna|salli|kendra|aria|jenny|nicky|allison|ava)\b/i;

export function guessGender(voice: SpeechSynthesisVoice): "male" | "female" | "?" {
  const n = voice.name;
  if (FEMALE.test(n)) return "female";
  if (MALE.test(n)) return "male";
  return "?";
}

export class VoiceCoach {
  private audio: AudioContext | null = null;

  constructor(private settings: VoiceSettings) {}

  setSettings(s: VoiceSettings) {
    this.settings = s;
  }

  /** Speak text now. Cancels any in-flight utterance to stay responsive. */
  say(text: string, opts?: { interrupt?: boolean; rateScale?: number }) {
    if (!speechSupported() || !this.settings.enabled) return;
    const synth = window.speechSynthesis;
    if (opts?.interrupt) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = clamp(this.settings.rate * (opts?.rateScale ?? 1), 0.5, 2);
    u.pitch = clamp(this.settings.pitch, 0, 2);
    u.volume = clamp(this.settings.volume, 0, 1);
    if (this.settings.voiceURI) {
      const v = synth.getVoices().find((x) => x.voiceURI === this.settings.voiceURI);
      if (v) u.lang = v.lang;
      if (v) u.voice = v;
    }
    synth.speak(u);
  }

  cancel() {
    if (speechSupported()) window.speechSynthesis.cancel();
  }

  /** Short tone (used for countdown ticks / go). */
  beep(freq = 880, durMs = 120, gain = 0.18) {
    if (!this.settings.beeps) return;
    try {
      if (!this.audio) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audio = new Ctx();
      }
      const ctx = this.audio;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + durMs / 1000 + 0.02);
    } catch {
      /* audio unavailable */
    }
  }

  /** Unlock audio + speech on a user gesture (call from the Start handler). */
  prime() {
    if (speechSupported()) {
      // a near-silent utterance primes the engine without being audible
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
    try {
      if (!this.audio) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audio = new Ctx();
      }
      void this.audio.resume();
    } catch {
      /* ignore */
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
