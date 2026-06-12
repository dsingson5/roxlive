/**
 * R-R artifact correction.
 *
 * The PDF stresses that DFA-alpha-1 is "exquisitely sensitive to R-R artifacts"
 * and that a moderate correction is required before computing it. We use a
 * local-median relative-deviation filter (the approach used by Kubios "medium"
 * / alphaHRV): a beat is an artifact if it deviates from the median of its
 * neighbourhood by more than `threshold` (fraction, e.g. 0.25 = 25%).
 *
 * Rejected beats are removed (not interpolated) for DFA, which is the
 * conservative choice recommended for scaling-exponent estimation.
 */

export interface CleanResult {
  /** accepted R-R intervals, ms */
  clean: number[];
  /** fraction 0..1 of input beats rejected */
  artifactPct: number;
  /** indices (into input) that were rejected */
  rejected: number[];
}

/**
 * @param rr        raw R-R intervals, ms
 * @param threshold relative deviation that counts as an artifact (default 0.25)
 * @param win       half-width of the local median window in beats (default 5)
 */
export function cleanRR(rr: number[], threshold = 0.25, win = 5): CleanResult {
  const n = rr.length;
  if (n === 0) return { clean: [], artifactPct: 0, rejected: [] };

  const clean: number[] = [];
  const rejected: number[] = [];

  for (let i = 0; i < n; i++) {
    const v = rr[i];

    // Hard physiological gate: 250 ms (240 bpm) .. 2000 ms (30 bpm).
    if (!Number.isFinite(v) || v < 250 || v > 2000) {
      rejected.push(i);
      continue;
    }

    // Local median over a window centred on i (excluding i itself).
    const lo = Math.max(0, i - win);
    const hi = Math.min(n - 1, i + win);
    const neigh: number[] = [];
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const w = rr[j];
      if (Number.isFinite(w) && w >= 250 && w <= 2000) neigh.push(w);
    }

    if (neigh.length < 2) {
      // Not enough context to judge — accept.
      clean.push(v);
      continue;
    }

    const med = median(neigh);
    const dev = Math.abs(v - med) / med;
    if (dev > threshold) {
      rejected.push(i);
    } else {
      clean.push(v);
    }
  }

  return {
    clean,
    artifactPct: rejected.length / n,
    rejected,
  };
}

export function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

export function stdev(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return NaN;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - 1));
}
