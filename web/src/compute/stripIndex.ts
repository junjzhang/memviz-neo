import type { TimelineAlloc } from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";

export interface StripIndex {
  /** Per-bucket max y (in bytes) — Y auto-fit reads this for O(B) window max. */
  bMax: Float32Array;
  /** Per-bucket candidate alloc indices — hit-test only scans the cursor's bucket. */
  packed: Int32Array[];
  /** Bucket width in stripBuffer X-units (μs-since-origin or event index). */
  bw: number;
  /** Number of buckets. */
  B: number;
}

/**
 * One-pass bucket index over stripBuffer. Combines two derived structures
 * the timeline needs on every frame: bucket-max-y for Y auto-fit, and
 * per-bucket alloc-id lists for hit-test. Rebuilt only when allocs,
 * stripBuffer, or totalXRange change.
 */
export function buildStripIndex(
  allocs: TimelineAlloc[],
  stripBuffer: Float32Array,
  totalXRange: number,
  B: number = 256,
): StripIndex | null {
  if (totalXRange <= 0) return null;
  const bw = totalXRange / B;
  const bMax = new Float32Array(B);
  const sets: Set<number>[] = Array.from({ length: B }, () => new Set());

  for (let bi = 0; bi < allocs.length; bi++) {
    const alloc = allocs[bi];
    const sz = alloc.size;
    const off0 = alloc.stripOffset;
    const count = alloc.stripCount;
    for (let si = 0; si < count; si++) {
      const off = (off0 + si) * STRIP_FLOATS;
      const ts = stripBuffer[off];
      const te = stripBuffer[off + 1];
      const top = stripBuffer[off + 2] + sz;
      const bStart = Math.max(0, Math.floor(ts / bw));
      const bEnd = Math.min(B - 1, Math.floor((te - 1) / bw));
      for (let b = bStart; b <= bEnd; b++) {
        if (top > bMax[b]) bMax[b] = top;
        sets[b].add(bi);
      }
    }
  }

  const packed = sets.map((s) => {
    const a = new Int32Array(s.size);
    let i = 0;
    for (const v of s) a[i++] = v;
    return a;
  });
  return { bMax, packed, bw, B };
}
