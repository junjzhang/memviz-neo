/**
 * Worker pool for parallel rank processing.
 * Main thread compiles WASM once, distributes Module to workers.
 *
 * Workers only do parse+pack and exit — there is no longer a detail
 * channel for stack-trace lookups, because the main thread resolves
 * everything via framePool / stackPool carried in RankData.
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
  inFlightRanks: number[];
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
  const poolSize = Math.max(1, Math.min(requested, 32));
  const workers: Worker[] = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(new Worker(new URL("./computeWorker.ts", import.meta.url), { type: "module" }));
  }

  let terminated = false;

  async function processAll(tasks: WorkerTask[]) {
    if (terminated || tasks.length === 0) return;

    const total = tasks.length;
    const workerCurrentRank = new Array(workers.length).fill(-1);
    const snap = (completed: number, phase: LoadPhase): ProgressSnapshot => {
      const inFlightRanks: number[] = [];
      for (const r of workerCurrentRank) if (r >= 0) inFlightRanks.push(r);
      return {
        completed,
        inFlight: inFlightRanks.length,
        total,
        phase,
        inFlightRanks,
        poolSize: workers.length,
      };
    };

    onProgress(snap(0, "compile_wasm"));
    const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    const wasmModule = await WebAssembly.compile(wasmBytes);
    onProgress(snap(0, "init_workers"));

    await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.error));
      };
      w.postMessage({ type: "init", wasmModule });
    })));

    let completed = 0;
    let nextIdx = 0;

    onProgress(snap(0, "parsing"));

    await new Promise<void>((resolve) => {
      function done(worker: Worker) {
        completed++;
        const wIdx = workers.indexOf(worker);
        workerCurrentRank[wIdx] = -1;
        onProgress(snap(completed, completed >= total ? "done" : "parsing"));
        if (completed >= total) resolve();
        else dispatch(worker);
      }

      function dispatch(worker: Worker) {
        if (nextIdx >= tasks.length) return;
        const task = tasks[nextIdx++];
        const wIdx = workers.indexOf(worker);
        workerCurrentRank[wIdx] = task.rank;
        onProgress(snap(completed, "parsing"));
        task.getBuffer().then((buffer) => {
          worker.postMessage({ type: "process", rank: task.rank, buffer }, [buffer]);
        }).catch((err) => {
          onError(task.rank, `File read failed: ${err}`);
          done(worker);
        });
      }

      for (const worker of workers) {
        worker.onmessage = (e: MessageEvent) => {
          const { type, rank, data, error } = e.data;
          if (type === "result") onResult({ rank, data });
          else if (type === "error") onError(rank, error);
          done(worker);
        };
        worker.onerror = (e) => {
          onError(-1, `Worker crashed: ${e.message}`);
          done(worker);
        };
        dispatch(worker);
      }
    });
  }

  function terminate() {
    terminated = true;
    for (const w of workers) w.terminate();
    workers.length = 0;
  }

  return { processAll, terminate };
}
