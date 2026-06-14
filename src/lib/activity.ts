/**
 * Lightweight activity logging. Buffers meaningful in-app events (app opened, a
 * feature/mode opened, a workout started/finished, history viewed) and flushes
 * them to the sync Worker in small batches for the signed-in athlete, so the
 * coach's Admin view can show what the crew has been doing. No raw input is
 * captured. No-op when not signed in (postActivity needs a session token).
 */

import { postActivity, loadSession } from "./sync";

let buffer: { type: string; detail?: string }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export function logActivity(type: string, detail?: string): void {
  if (!loadSession()) return; // only attribute events to a signed-in athlete
  buffer.push(detail ? { type, detail } : { type });
  if (buffer.length >= 20) {
    flushActivity();
    return;
  }
  if (!timer) timer = setTimeout(() => { timer = null; flushActivity(); }, 2500);
}

/** Send buffered events now (also call on pagehide so a tail isn't lost). */
export function flushActivity(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buffer.length) return;
  const events = buffer;
  buffer = [];
  postActivity(events);
}
