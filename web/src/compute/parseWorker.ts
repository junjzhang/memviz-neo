/**
 * Parse worker (serial, singleton). Runs WASM parse_intern — the
 * expensive pickle decode + frame intern + alloc pairing stage. Emits
 * an IR JSON string that a layout worker post-processes.
 *
 * Main → Worker: { type: "init", wasmModule }
 * Main → Worker: { type: "parse", rank, buffer }  // buffer transferred
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "ir", rank, ir }
 * Worker → Main: { type: "error", rank, error }
 */

import { initSync, parse_intern } from "../../../wasm/pkg/memviz_wasm.js";

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

  if (type === "parse") {
    const { rank, buffer } = e.data;
    try {
      if (!ready || !wasmModule) throw new Error("WASM not initialized");
      const t0 = performance.now();
      const ir = parse_intern(new Uint8Array(buffer), rank, 3000);
      const wasmMs = performance.now() - t0;
      (self as any).postMessage({ type: "ir", rank, ir, wasmMs, irBytes: ir.length });
      initSync({ module: wasmModule });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }
};
