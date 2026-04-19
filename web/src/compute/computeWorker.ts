/**
 * Web Worker: runs WASM and packs the result into a RankData the main
 * thread can consume directly. With interned frame/stack pools in place,
 * the worker no longer needs to hold a detail cache or answer async
 * detail requests — all traces resolve main-thread from the pools.
 *
 * Main → Worker: { type: "init", wasmModule }
 * Main → Worker: { type: "process", rank, buffer }
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "result", rank, data }  // stripBuffer transferred
 * Worker → Main: { type: "error", rank, error }
 */

import { initSync, process_snapshot } from "../../../wasm/pkg/memviz_wasm.js";
import { parseRank } from "./parseRank";

let wasmModule: WebAssembly.Module | null = null;
let ready = false;

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    try {
      wasmModule = e.data.wasmModule;
      initSync({ module: wasmModule! });
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
      if (!ready || !wasmModule) throw new Error("WASM not initialized");
      const json = process_snapshot(new Uint8Array(buffer), rank, 3000);
      const { data } = parseRank(json, rank);
      (self as any).postMessage(
        { type: "result", rank, data },
        [data.stripBuffer.buffer, ...data.stackPool.map((p) => p.buffer)],
      );
      // Recycle the WASM instance between ranks to drop peak linear memory.
      initSync({ module: wasmModule });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }
};
