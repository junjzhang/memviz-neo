/**
 * Layout worker (pool, N workers). Accepts IR JSON from the parse
 * worker and runs polygon layout + treemap + anomaly detection + strip
 * packing. The full RankData stays in this worker's local Map; only a
 * small summary is posted back during load. Main thread requests the
 * full data on demand (rank switch).
 *
 * Main → Worker: { type: "layout", rank, ir }
 * Worker → Main: { type: "summary", rank, summary, layoutMs, irBytes }
 *
 * Main → Worker: { type: "requestFull", rank, requestId }
 * Worker → Main: { type: "full", rank, requestId, data }
 *              | { type: "fullMiss", rank, requestId }
 *
 * Worker → Main: { type: "error", rank, error }
 */

import { parseRank } from "./parseRank";
import type { RankData } from "./index";

const fullData = new Map<number, RankData>();

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "layout") {
    const { rank, ir } = e.data;
    try {
      const t0 = performance.now();
      const { data } = parseRank(ir, rank);
      const layoutMs = performance.now() - t0;
      fullData.set(rank, data);
      // Summary is plain + tiny; structured clone cost is negligible.
      (self as any).postMessage({
        type: "summary",
        rank,
        summary: data.summary,
        layoutMs,
        irBytes: (ir as string).length,
      });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }

  if (type === "requestFull") {
    const { rank, requestId } = e.data;
    const data = fullData.get(rank);
    if (!data) {
      (self as any).postMessage({ type: "fullMiss", rank, requestId });
      return;
    }
    // Don't transfer — transfer is one-shot and we want to serve future
    // requests for this same rank. structuredClone (default postMessage)
    // copies typed arrays; ~5-20ms for a couple MB on main thread.
    (self as any).postMessage({ type: "full", rank, requestId, data });
    return;
  }
};
