/**
 * Two-stage worker pool.
 *
 * Stage 1 — parse: K WASM workers, pickle → IR JSON.
 * Stage 2 — layout: K pure-JS workers, IR → full RankData. Layout
 *   workers hold the full RankData locally; during the load they emit
 *   only a ~64-byte summary to the main thread. This is the key move
 *   that keeps main-thread long tasks near-zero during a 128-rank
 *   load: no structured-clone-a-full-RankData-per-flush.
 *
 * Rank switch: main thread calls requestFull(rank); the pool routes
 * to the worker that produced that rank and posts back a full
 * structured clone (not a transfer — repeatable). ~20-50ms per switch.
 */

// @ts-ignore — Vite handles this URL pattern for WASM
import wasmUrl from "../../../wasm/pkg/memviz_wasm_bg.wasm?url";
import type { RankData } from "./index";

export interface WorkerTask {
  rank: number;
  getBuffer: () => Promise<ArrayBuffer>;
}

export interface RankSummary {
  rank: number;
  total_reserved: number;
  total_allocated: number;
  total_active: number;
  segment_count: number;
  block_count: number;
  active_bytes: number;
  inactive_bytes: number;
  baseline?: number;
  alloc_conf?: string;
  expandable_segments?: boolean;
  max_split_size?: number;
  gc_threshold?: number;
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
  inFlightRanks: number[];
  poolSize: number;
}

export interface WorkerPool {
  processAll: (tasks: WorkerTask[], opts?: { layoutLimit?: number }) => Promise<void>;
  requestFull: (rank: number) => Promise<RankData>;
  terminate: () => void;
}

interface PendingRequest {
  resolve: (data: RankData) => void;
  reject: (err: Error) => void;
}

export function createWorkerPool(
  onSummary: (rank: number, summary: RankSummary) => void,
  onError: (rank: number, error: string) => void,
  onProgress: (snap: ProgressSnapshot) => void,
  opts?: { poolSize?: number },
): WorkerPool {
  const requested = opts?.poolSize ?? Math.min(navigator.hardwareConcurrency || 4, 8);
  const K = Math.max(1, Math.min(requested, 32));

  const parseWorkers: Worker[] = [];
  for (let i = 0; i < K; i++) {
    parseWorkers.push(new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" }));
  }
  const layoutWorkers: Worker[] = [];
  for (let i = 0; i < K; i++) {
    layoutWorkers.push(new Worker(new URL("./layoutWorker.ts", import.meta.url), { type: "module" }));
  }

  // Which layout worker produced each rank — used to route requestFull.
  const rankOwner = new Map<number, Worker>();
  // Outstanding requestFull promises keyed by requestId.
  const pendingFullRequests = new Map<number, PendingRequest>();
  let nextRequestId = 1;

  let terminated = false;

  // Hot-path timing. Aggregated into window.__memvizStats on each
  // processAll run so the extension can pull it out after a load and
  // identify which handler is producing main-thread long tasks.
  const stats: Record<string, { count: number; sumMs: number; maxMs: number }> = {};
  function timed<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    const r = fn();
    const dur = performance.now() - t0;
    const s = stats[label] || (stats[label] = { count: 0, sumMs: 0, maxMs: 0 });
    s.count++;
    s.sumMs += dur;
    if (dur > s.maxMs) s.maxMs = dur;
    return r;
  }
  if (typeof window !== "undefined" && import.meta.env.DEV) {
    (window as any).__memvizStats = stats;
  }

  async function processAll(tasks: WorkerTask[], opts?: { layoutLimit?: number }) {
    if (terminated || tasks.length === 0) return;
    const layoutLimit = opts?.layoutLimit ?? 3000;

    const total = tasks.length;
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

    // Coalesce onProgress to one call per animation frame. Without this,
    // worker messages (128 ranks × ~8 events = ~1000 pumps) fire per-message
    // fileStore.set()s that slice vsync windows and drop frames in the
    // timeline's WebGL render.
    let rafPending = false;
    let pendingSnap: ProgressSnapshot | null = null;
    const flushProgress = () => {
      rafPending = false;
      if (pendingSnap) {
        const s = pendingSnap;
        pendingSnap = null;
        timed("onProgress", () => onProgress(s));
      }
    };
    const scheduleProgress = (s: ProgressSnapshot) => {
      pendingSnap = s;
      if (rafPending) return;
      rafPending = true;
      (typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(cb, 16))(flushProgress);
    };

    // Phase transitions (compile_wasm, init_workers, done) are rare —
    // emit these synchronously so the UI gate flips instantly.
    onProgress(snap(0, "compile_wasm"));
    const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    const wasmModule = await WebAssembly.compile(wasmBytes);
    onProgress(snap(0, "init_workers"));

    await Promise.all(parseWorkers.map((w) => new Promise<void>((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.error));
      };
      w.postMessage({ type: "init", wasmModule });
    })));

    let completed = 0;
    let nextTaskIdx = 0;
    const layoutQueue: { rank: number; ir: string }[] = [];
    const idleParseWorkers: Worker[] = [...parseWorkers];
    const idleLayoutWorkers: Worker[] = [...layoutWorkers];

    interface Timing { rank: number; wasmMs: number; irKB: number; layoutMs: number; totalMs: number; }
    const timings = new Map<number, Timing>();
    const startedAt = new Map<number, number>();
    const wallStart = performance.now();

    scheduleProgress(snap(0, "parsing"));

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
          scheduleProgress(snap(completed, "parsing"));
          task.getBuffer().then((buffer) => {
            worker.postMessage({ type: "parse", rank: task.rank, buffer, layoutLimit }, [buffer]);
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
          rankOwner.set(rank, worker);
          scheduleProgress(snap(completed, "parsing"));
          worker.postMessage({ type: "layout", rank, ir });
        }
      }

      for (const worker of parseWorkers) {
        worker.onmessage = (e: MessageEvent) => timed("parse:msg", () => {
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
        });
        worker.onerror = (e) => {
          const wIdx = parseWorkers.indexOf(worker);
          onError(-1, `Parse worker crashed: ${e.message}`);
          parseBusyRank[wIdx] = -1;
          idleParseWorkers.push(worker);
          maybeFinish();
        };
      }

      for (const worker of layoutWorkers) {
        worker.onmessage = (e: MessageEvent) => timed(`layout:${e.data.type}`, () => {
          const { type, rank, summary, error, layoutMs, requestId, data } = e.data;
          const wIdx = layoutWorkers.indexOf(worker);
          if (type === "summary") {
            timed("onSummary", () => onSummary(rank, summary));
            completed++;
            const t = timings.get(rank);
            if (t) {
              t.layoutMs = Math.round(layoutMs);
              const start = startedAt.get(rank) ?? wallStart;
              t.totalMs = Math.round(performance.now() - start);
            }
            layoutBusyRank[wIdx] = -1;
            idleLayoutWorkers.push(worker);
            scheduleProgress(snap(completed, completed >= total ? "done" : "parsing"));
            dispatchLayoutIfPossible();
            maybeFinish();
          } else if (type === "full") {
            const p = pendingFullRequests.get(requestId);
            if (p) { pendingFullRequests.delete(requestId); p.resolve(data); }
          } else if (type === "fullMiss") {
            const p = pendingFullRequests.get(requestId);
            if (p) { pendingFullRequests.delete(requestId); p.reject(new Error(`rank ${rank} not held by worker`)); }
          } else if (type === "error") {
            onError(rank, error);
            completed++;
            layoutBusyRank[wIdx] = -1;
            idleLayoutWorkers.push(worker);
            scheduleProgress(snap(completed, completed >= total ? "done" : "parsing"));
            dispatchLayoutIfPossible();
            maybeFinish();
          }
        });
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

  function requestFull(rank: number): Promise<RankData> {
    const worker = rankOwner.get(rank);
    if (!worker) return Promise.reject(new Error(`no worker owns rank ${rank}`));
    const requestId = nextRequestId++;
    return new Promise<RankData>((resolve, reject) => {
      pendingFullRequests.set(requestId, { resolve, reject });
      worker.postMessage({ type: "requestFull", rank, requestId });
    });
  }

  function terminate() {
    terminated = true;
    for (const p of pendingFullRequests.values()) p.reject(new Error("pool terminated"));
    pendingFullRequests.clear();
    rankOwner.clear();
    for (const w of parseWorkers) w.terminate();
    for (const w of layoutWorkers) w.terminate();
    parseWorkers.length = 0;
    layoutWorkers.length = 0;
  }

  return { processAll, requestFull, terminate };
}
