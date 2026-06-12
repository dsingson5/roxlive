/**
 * Time-domain HRV over a rolling R-R window.
 *   RMSSD = sqrt(mean(ΔRR²))  — vagal / parasympathetic tone
 *   SDNN  = std(RR)           — overall variability
 * Both computed on artifact-cleaned beats.
 */

import { cleanRR, mean, stdev } from "./artifact";
import type { HrvResult } from "../types";

export function computeHRV(rrWindow: number[]): HrvResult {
  const { clean } = cleanRR(rrWindow);
  const n = clean.length;
  if (n < 8) return { rmssd: null, sdnn: null, beats: n };

  let sumSq = 0;
  for (let i = 1; i < n; i++) {
    const d = clean[i] - clean[i - 1];
    sumSq += d * d;
  }
  const rmssd = Math.sqrt(sumSq / (n - 1));
  const sdnn = stdev(clean);

  return {
    rmssd: Number.isFinite(rmssd) ? rmssd : null,
    sdnn: Number.isFinite(sdnn) ? sdnn : null,
    beats: n,
  };
}

export { mean };
