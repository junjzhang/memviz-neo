/**
 * Web Worker: receives compiled WASM Module from main thread, initializes
 * with initSync, processes pickle snapshots, AND parses the WASM JSON
 * output into RankData — all off the main thread.
 *
 * Main → Worker: { type: "init", wasmModule: WebAssembly.Module }
 * Main → Worker: { type: "process", rank: number, buffer: ArrayBuffer }
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "result", rank: number, data: RankData }   // stripBuffer transferred
 * Worker → Main: { type: "error", rank: number, error: string }
 */

import { initSync, process_snapshot } from "../../../wasm/pkg/memviz_wasm.js";
import { parseRank } from "./parseRank";

let ready = false;

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
      // Parse + build RankData in the worker. Main thread will only do
      // a structured-clone receive + Map.set — no JSON.parse, no loops.
      const data = parseRank(json, rank);
      // Transfer the Float32 strip buffer zero-copy; the rest structured-clones.
      (self as any).postMessage(
        { type: "result", rank, data },
        [data.stripBuffer.buffer],
      );
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
  }
};
