/**
 * Web Worker: receives compiled WASM Module from main thread,
 * initializes with initSync, processes pickle snapshots.
 *
 * Main → Worker: { type: "init", wasmModule: WebAssembly.Module }
 * Main → Worker: { type: "process", rank: number, buffer: ArrayBuffer }
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "result", rank: number, json: string }
 * Worker → Main: { type: "error", rank: number, error: string }
 */

import { initSync, process_snapshot } from "../../../wasm/pkg/memviz_wasm.js";

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
      (self as any).postMessage({ type: "result", rank, json });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
  }
};
