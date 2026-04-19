/**
 * Web Worker: WASM parse + RankData build, keeps frames worker-local.
 *
 * Main → Worker: { type: "init", wasmModule }
 * Main → Worker: { type: "process", rank, buffer }
 * Main → Worker: { type: "detail", reqId, rank, addr }
 *
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "result", rank, data }           // stripBuffer transferred
 * Worker → Main: { type: "detail_response", reqId, frames }
 * Worker → Main: { type: "error", rank, error }
 */

import { initSync, process_snapshot } from "../../../wasm/pkg/memviz_wasm.js";
import { parseRank } from "./parseRank";

type Frame = { name: string; filename: string; line: number };

let ready = false;
// Per-rank frames table. Never sent to main thread; used to answer detail
// requests on demand.
const framesCache = new Map<number, Map<number, Frame[]>>();

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    try {
      initSync({ module: e.data.wasmModule });
      ready = true;
      (self as any).postMessage({ type: "ready" });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank: -1, error: `WASM init: ${err}` });
    }
    return;
  }

  if (type === "process") {
    const { rank, buffer } = e.data;
    try {
      if (!ready) throw new Error("WASM not initialized");
      const json = process_snapshot(new Uint8Array(buffer), rank, 3000);
      const { data, framesByAddr } = parseRank(json, rank);
      framesCache.set(rank, framesByAddr);
      (self as any).postMessage(
        { type: "result", rank, data },
        [data.stripBuffer.buffer],
      );
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }

  if (type === "detail") {
    const { reqId, rank, addr } = e.data;
    const rankFrames = framesCache.get(rank);
    const frames = rankFrames?.get(addr) ?? [];
    (self as any).postMessage({ type: "detail_response", reqId, frames });
    return;
  }
};
