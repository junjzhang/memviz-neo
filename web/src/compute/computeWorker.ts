/**
 * Web Worker: WASM parse + RankData build, keeps full allocation detail
 * (addr/size/time/top_frame/frames) worker-local. Main thread only sees
 * the small aggregates (summary, treemap, stripBuffer, etc.).
 *
 * Main → Worker: { type: "init", wasmModule }
 * Main → Worker: { type: "process", rank, buffer }
 * Main → Worker: { type: "detail", reqId, rank, addr }
 *
 * Worker → Main: { type: "ready" }
 * Worker → Main: { type: "result", rank, data }            // stripBuffer transferred
 * Worker → Main: { type: "detail_response", reqId, detail } // detail|null
 * Worker → Main: { type: "error", rank, error }
 */

import { initSync, process_snapshot } from "../../../wasm/pkg/memviz_wasm.js";
import { parseRank } from "./parseRank";

let wasmModule: WebAssembly.Module | null = null;

interface AllocDetail {
  addr: number;
  size: number;
  alloc_us: number;
  free_us: number;
  top_frame: string;
  frames: { name: string; filename: string; line: number }[];
}

let ready = false;
const detailCache = new Map<number, Map<number, AllocDetail>>();

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
      const { data, detailsByAddr } = parseRank(json, rank);
      detailCache.set(rank, detailsByAddr);
      (self as any).postMessage(
        { type: "result", rank, data },
        [data.stripBuffer.buffer],
      );
      // Recycle the WASM instance between ranks. The serde-pickle patch
      // keeps memoized values alive for correctness — which in PyTorch
      // traces means thousands of cloned Vec<Frame>s until the rank-level
      // Value tree is dropped. The linear memory those clones used can't
      // shrink (WebAssembly.Memory is grow-only), but re-initSync gives
      // us a fresh Memory and the old one becomes garbage.
      initSync({ module: wasmModule });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", rank, error: String(err) });
    }
    return;
  }

  if (type === "detail") {
    const { reqId, rank, addr } = e.data;
    const detail = detailCache.get(rank)?.get(addr) ?? null;
    (self as any).postMessage({ type: "detail_response", reqId, detail });
    return;
  }
};
