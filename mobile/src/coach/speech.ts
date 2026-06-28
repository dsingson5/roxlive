/**
 * Spoken coaching via expo-speech (native TTS) — the RN analogue of the web
 * app's SpeechSynthesis wrapper. `interrupt` stops any in-flight utterance so
 * the rep count / cue stays current.
 */
import * as Speech from "expo-speech";

let enabled = true;

export function setVoiceEnabled(on: boolean): void {
  enabled = on;
  if (!on) Speech.stop();
}

export function say(text: string, opts?: { interrupt?: boolean }): void {
  if (!enabled || !text) return;
  if (opts?.interrupt) Speech.stop();
  Speech.speak(text, { rate: 1.05, pitch: 1.0 });
}

export function stopSpeech(): void {
  Speech.stop();
}
