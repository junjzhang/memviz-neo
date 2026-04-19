/**
 * Layout worker (pool, N workers). Pure JS — no WASM. Accepts the IR
 * JSON from the parse worker, runs polygon layout, treemap, anomaly
 * detection, and strip packing, then sends a RankData back to main.
 *
 * Main → Worker: { type: "layout", rank, ir }
 * Worker → Main: { type: "result", rank, data }  // stripBuffer + stackPool transferred
 * Worker → Main: { type: "error", rank, error }
 */

import { parseRank } from "./parseRank";

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;
  if (type !== "layout") return;
  const { rank, ir } = e.data;
  try {
    const t0 = performance.now();
    const { data } = parseRank(ir, rank);
    const layoutMs = performance.now() - t0;
    (self as any).postMessage(
      { type: "result", rank, data, layoutMs },
      [data.stripBuffer.buffer, ...data.stackPool.map((p) => p.buffer)],
    );
  } catch (err: any) {
    (self as any).postMessage({ type: "error", rank, error: String(err) });
  }
};
