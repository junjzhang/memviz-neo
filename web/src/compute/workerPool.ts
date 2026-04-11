/**
 * Worker pool for parallel rank processing.
 * Main thread compiles WASM once, distributes Module to workers.
 */

// @ts-ignore — Vite handles this URL pattern for WASM
import wasmUrl from "../../../wasm/pkg/memviz_wasm_bg.wasm?url";

export interface WorkerTask {
  rank: number;
  getBuffer: () => Promise<ArrayBuffer>;
}

export interface WorkerResult {
  rank: number;
  json: string;
}

export type LoadPhase =
  | "compile_wasm"
  | "init_workers"
  | "parsing"
  | "done";

export function createWorkerPool(
  onResult: (result: WorkerResult) => void,
  onError: (rank: number, error: string) => void,
  onProgress: (completed: number, inFlight: number, total: number, phase: LoadPhase) => void,
): {
  processAll: (tasks: WorkerTask[]) => Promise<void>;
  terminate: () => void;
} {
  const poolSize = Math.min(navigator.hardwareConcurrency || 4, 8);
  const workers: Worker[] = [];
  for (let i = 0; i < poolSize; i++) {
    workers.push(new Worker(new URL("./computeWorker.ts", import.meta.url), { type: "module" }));
  }

  let terminated = false;

  async function processAll(tasks: WorkerTask[]) {
    if (terminated || tasks.length === 0) return;

    const total = tasks.length;
    onProgress(0, 0, total, "compile_wasm");

    // Compile WASM once, share Module with all workers
    const wasmBytes = await fetch(wasmUrl).then((r) => r.arrayBuffer());
    const wasmModule = await WebAssembly.compile(wasmBytes);

    onProgress(0, 0, total, "init_workers");

    // Initialize all workers with the compiled module
    await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.type === "ready") resolve();
        else if (e.data.type === "error") reject(new Error(e.data.error));
      };
      w.postMessage({ type: "init", wasmModule });
    })));

    let completed = 0;
    let inFlight = 0;
    let nextIdx = 0;

    onProgress(0, 0, total, "parsing");

    return new Promise<void>((resolve) => {
      function done(worker: Worker) {
        completed++;
        inFlight = Math.max(0, inFlight - 1);
        onProgress(completed, inFlight, total, completed >= total ? "done" : "parsing");
        if (completed >= total) resolve();
        else dispatch(worker);
      }

      function dispatch(worker: Worker) {
        if (nextIdx >= tasks.length) return;
        const task = tasks[nextIdx++];
        inFlight++;
        onProgress(completed, inFlight, total, "parsing");
        task.getBuffer().then((buffer) => {
          worker.postMessage({ type: "process", rank: task.rank, buffer }, [buffer]);
        }).catch((err) => {
          onError(task.rank, `File read failed: ${err}`);
          done(worker);
        });
      }

      for (const worker of workers) {
        worker.onmessage = (e: MessageEvent) => {
          const { type, rank, json, error } = e.data;
          if (type === "result") onResult({ rank, json });
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
  }

  return { processAll, terminate };
}
