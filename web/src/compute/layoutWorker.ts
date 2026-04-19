/**
 * Layout worker (pool, N workers). Accepts IR JSON from the parse
 * worker and produces the summary for the main thread during load.
 * The IR string itself is what the worker holds on to, not the fully
 * decoded RankData — at layout_limit=20k+ each RankData costs ~50 MB
 * JS heap and 128 ranks of that pushes the worker above 6 GB.
 *
 * When main requests a full rank, we re-run parseRank from the cached
 * IR (~200-500ms at 20k) and structured-clone the result back. Users
 * switch ranks a few times, not constantly, so paying layout cost per
 * switch is the right trade.
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

const irStore = new Map<number, string>();

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "layout") {
    const { rank, ir } = e.data as { rank: number; ir: string };
    try {
      // Only pull `summary` out of the IR during load — it's tiny and
      // is all the main thread needs to render the rank selector.
      const t0 = performance.now();
      const raw = JSON.parse(ir);
      const summary = raw.summary;
      const layoutMs = performance.now() - t0;
      irStore.set(rank, ir);
      (self as any).postMessage({
        type: "summary",
        rank,
        summary,
        layoutMs,
        irBytes: ir.length,
      });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }

  if (type === "requestFull") {
    const { rank, requestId } = e.data;
    const ir = irStore.get(rank);
    if (!ir) {
      (self as any).postMessage({ type: "fullMiss", rank, requestId });
      return;
    }
    try {
      const { data } = parseRank(ir, rank);
      (self as any).postMessage({ type: "full", rank, requestId, data });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }
};
