/**
 * Two-stage worker pool.
 *
 * Stage 1 — parse: K workers, each runs WASM parse_intern (pickle decode
 *   + frame/stack intern + alloc/free pairing). WASM linear memory is
 *   grow-only, so peak WASM memory ≈ K × worst-rank-peak. Higher K gives
 *   linear parse throughput speedup at linear memory cost. Each worker
 *   recycles its WASM instance after every rank to bound steady-state.
 *
 * Stage 2 — layout: K workers, pure JS (no WASM). Polygon layout +
 *   treemap + anomaly detection + strip packing. Lives in JS heap which
 *   is GC'd, so parallel layout workers don't accumulate memory the
 *   way WASM does.
 *
 * Data flow: task → parse queue → idle parse worker → IR → layout queue
 *   → idle layout worker → RankData → main.
 *
 * Per-rank timings are logged to `console.table` at the end of each
 * processAll so you can see whether parse or layout is the bottleneck.
 */

// @ts-ignore — Vite handles this URL pattern for WASM
import wasmUrl from "../../../wasm/pkg/memviz_wasm_bg.wasm?url";
import type { RankData } from "./index";

export interface WorkerTask {
  rank: number;
  getBuffer: () => Promise<ArrayBuffer>;
}

export interface WorkerResult {
  rank: number;
  data: RankData;
}

export type LoadPhase =
  | "compile_wasm"
  | "init_workers"
  | "parsing"
  | "done";

export interface ProgressSnapshot {
  completed: number;
  inFlight: number;
  total: number;
  phase: LoadPhase;
  /** Rank numbers currently being parsed OR laid out. */
  inFlightRanks: number[];
  /** User-visible concurrency (parse/layout workers). */
  poolSize: number;
}

export interface WorkerPool {
  processAll: (tasks: WorkerTask[]) => Promise<void>;
  terminate: () => void;
}

export function createWorkerPool(
  onResult: (result: WorkerResult) => void,
  onError: (rank: number, error: string) => void,
  onProgress: (snap: ProgressSnapshot) => void,
  opts?: { poolSize?: number },
): WorkerPool {
  const requested = opts?.poolSize ?? Math.min(navigator.hardwareConcurrency || 4, 8);
  const K = Math.max(1, Math.min(requested, 32));

  // K parse workers (WASM) + K layout workers (pure JS).
  const parseWorkers: Worker[] = [];
  for (let i = 0; i < K; i++) {
    parseWorkers.push(new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" }));
  }
  const layoutWorkers: Worker[] = [];
  for (let i = 0; i < K; i++) {
    layoutWorkers.push(new Worker(new URL("./layoutWorker.ts", import.meta.url), { type: "module" }));
  }

  let terminated = false;

  async function processAll(tasks: WorkerTask[]) {
    if (terminated || tasks.length === 0) return;

    const total = tasks.length;

    // In-flight tracking (per-worker slot).
    const parseBusyRank: number[] = new Array(K).fill(-1);
    const layoutBusyRank: number[] = new Array(K).fill(-1);

    const snap = (completed: number, phase: LoadPhase): ProgressSnapshot => {
      const inFlightRanks: number[] = [];
      for (const r of parseBusyRank) if (r >= 0) inFlightRanks.push(r);
      for (const r of layoutBusyRank) if (r >= 0) inFlightRanks.push(r);
      return {
        completed,
        inFlight: inFlightRanks.length,
        total,
        phase,
        inFlightRanks,
        poolSize: K,
      };
    };

    onProgress(snap(0, "compile_wasm"));
    const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    const wasmModule = await WebAssembly.compile(wasmBytes);
    onProgress(snap(0, "init_workers"));

    // Init all parse workers in parallel.
    await Promise.all(parseWorkers.map((w) => new Promise<void>((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.error));
      };
      w.postMessage({ type: "init", wasmModule });
    })));

    // ---- Scheduler state ----
    let completed = 0;
    let nextTaskIdx = 0;
    const layoutQueue: { rank: number; ir: string }[] = [];
    const idleParseWorkers: Worker[] = [...parseWorkers];
    const idleLayoutWorkers: Worker[] = [...layoutWorkers];

    // Per-rank timing for the final console.table summary.
    interface Timing { rank: number; wasmMs: number; irKB: number; layoutMs: number; totalMs: number; }
    const timings = new Map<number, Timing>();
    const startedAt = new Map<number, number>();
    const wallStart = performance.now();

    onProgress(snap(0, "parsing"));

    await new Promise<void>((resolveAll) => {
      function maybeFinish() {
        const parseDone = nextTaskIdx >= tasks.length && idleParseWorkers.length === parseWorkers.length;
        const layoutDone = layoutQueue.length === 0 && idleLayoutWorkers.length === layoutWorkers.length;
        if (parseDone && layoutDone) resolveAll();
      }

      function dispatchParseIfPossible() {
        while (idleParseWorkers.length > 0 && nextTaskIdx < tasks.length) {
          const worker = idleParseWorkers.shift()!;
          const wIdx = parseWorkers.indexOf(worker);
          const task = tasks[nextTaskIdx++];
          parseBusyRank[wIdx] = task.rank;
          startedAt.set(task.rank, performance.now());
          onProgress(snap(completed, "parsing"));
          task.getBuffer().then((buffer) => {
            worker.postMessage({ type: "parse", rank: task.rank, buffer }, [buffer]);
          }).catch((err) => {
            onError(task.rank, `File read failed: ${err}`);
            parseBusyRank[wIdx] = -1;
            idleParseWorkers.push(worker);
            dispatchParseIfPossible();
            maybeFinish();
          });
        }
      }

      function dispatchLayoutIfPossible() {
        while (idleLayoutWorkers.length > 0 && layoutQueue.length > 0) {
          const worker = idleLayoutWorkers.shift()!;
          const { rank, ir } = layoutQueue.shift()!;
          const wIdx = layoutWorkers.indexOf(worker);
          layoutBusyRank[wIdx] = rank;
          onProgress(snap(completed, "parsing"));
          worker.postMessage({ type: "layout", rank, ir });
        }
      }

      for (const worker of parseWorkers) {
        worker.onmessage = (e: MessageEvent) => {
          const { type, rank, ir, error, wasmMs, irBytes } = e.data;
          const wIdx = parseWorkers.indexOf(worker);
          if (type === "ir") {
            timings.set(rank, {
              rank,
              wasmMs: Math.round(wasmMs),
              irKB: Math.round((irBytes || 0) / 1024),
              layoutMs: 0,
              totalMs: 0,
            });
            layoutQueue.push({ rank, ir });
            parseBusyRank[wIdx] = -1;
            idleParseWorkers.push(worker);
            dispatchParseIfPossible();
            dispatchLayoutIfPossible();
          } else if (type === "error") {
            onError(rank, error);
            parseBusyRank[wIdx] = -1;
            idleParseWorkers.push(worker);
            dispatchParseIfPossible();
            maybeFinish();
          }
        };
        worker.onerror = (e) => {
          const wIdx = parseWorkers.indexOf(worker);
          onError(-1, `Parse worker crashed: ${e.message}`);
          parseBusyRank[wIdx] = -1;
          idleParseWorkers.push(worker);
          maybeFinish();
        };
      }

      for (const worker of layoutWorkers) {
        worker.onmessage = (e: MessageEvent) => {
          const { type, rank, data, error, layoutMs } = e.data;
          const wIdx = layoutWorkers.indexOf(worker);
          if (type === "result") {
            onResult({ rank, data });
            completed++;
            const t = timings.get(rank);
            if (t) {
              t.layoutMs = Math.round(layoutMs);
              const start = startedAt.get(rank) ?? wallStart;
              t.totalMs = Math.round(performance.now() - start);
            }
          } else if (type === "error") {
            onError(rank, error);
            completed++;
          }
          layoutBusyRank[wIdx] = -1;
          idleLayoutWorkers.push(worker);
          onProgress(snap(completed, completed >= total ? "done" : "parsing"));
          dispatchLayoutIfPossible();
          maybeFinish();
        };
        worker.onerror = (e) => {
          const wIdx = layoutWorkers.indexOf(worker);
          onError(-1, `Layout worker crashed: ${e.message}`);
          layoutBusyRank[wIdx] = -1;
          idleLayoutWorkers.push(worker);
          maybeFinish();
        };
      }

      dispatchParseIfPossible();
    });

    const wallMs = Math.round(performance.now() - wallStart);
    const rows = [...timings.values()].sort((a, b) => a.rank - b.rank);
    if (rows.length > 0) {
      const sumWasm = rows.reduce((s, r) => s + r.wasmMs, 0);
      const sumLayout = rows.reduce((s, r) => s + r.layoutMs, 0);
      // eslint-disable-next-line no-console
      console.groupCollapsed(`[memviz] loaded ${rows.length} ranks in ${wallMs}ms (K=${K}) · parse Σ=${sumWasm}ms · layout Σ=${sumLayout}ms`);
      // eslint-disable-next-line no-console
      console.table(rows);
      // eslint-disable-next-line no-console
      console.groupEnd();
    }
  }

  function terminate() {
    terminated = true;
    for (const w of parseWorkers) w.terminate();
    for (const w of layoutWorkers) w.terminate();
    parseWorkers.length = 0;
    layoutWorkers.length = 0;
  }

  return { processAll, terminate };
}
