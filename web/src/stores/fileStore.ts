import { create } from "zustand";
import type { RankData } from "../compute";
import {
  createWorkerPool,
  type WorkerPool,
  type WorkerResult,
  type WorkerTask,
  type LoadPhase,
} from "../compute/workerPool";

type FileReader = () => Promise<ArrayBuffer>;

// Active pool is kept alive after parsing finishes so the main thread can
// ask workers for per-allocation stack traces on demand. Terminated on reset.
let activePool: WorkerPool | null = null;

export function getActivePool(): WorkerPool | null {
  return activePool;
}

interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  fileNames: string[];
  progress: number;
  phase: LoadPhase | "idle";
  completedCount: number;
  inFlightCount: number;
  totalCount: number;
  error: string | null;
  ranks: number[];
  rankData: Map<number, RankData>;

  openDirectory: () => Promise<void>;
  openFiles: (files: FileList) => Promise<void>;
  reset: () => void;
}

function extractRank(filename: string): number {
  const m = filename.match(/rank(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export const useFileStore = create<FileState>((set) => ({
  status: "idle",
  fileNames: [],
  progress: 0,
  phase: "idle",
  completedCount: 0,
  inFlightCount: 0,
  totalCount: 0,
  error: null,
  ranks: [],
  rankData: new Map(),

  openDirectory: async () => {
    try {
      const dirHandle = await (window as any).showDirectoryPicker();
      const entries: { name: string; reader: FileReader }[] = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".pickle")) {
          const handle = entry;
          entries.push({ name: entry.name, reader: async () => (await handle.getFile()).arrayBuffer() });
        }
      }
      await loadAllParallel(entries, set);
    } catch (e: any) {
      if (e.name === "AbortError") return;
      set({ status: "error", error: String(e) });
    }
  },

  openFiles: async (fileList: FileList) => {
    const entries = Array.from(fileList)
      .filter((f) => f.name.endsWith(".pickle"))
      .map((f) => ({ name: f.name, reader: () => f.arrayBuffer() }));
    await loadAllParallel(entries, set);
  },

  reset: () => {
    if (activePool) {
      activePool.terminate();
      activePool = null;
    }
    set({
      status: "idle",
      fileNames: [],
      progress: 0,
      phase: "idle",
      completedCount: 0,
      inFlightCount: 0,
      totalCount: 0,
      error: null,
      ranks: [],
      rankData: new Map(),
    });
  },
}));

async function loadAllParallel(
  entries: { name: string; reader: FileReader }[],
  set: (partial: Partial<FileState>) => void,
) {
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) { set({ status: "error", error: "No .pickle files found" }); return; }

  const ranks = entries.map((e) => extractRank(e.name)).sort((a, b) => a - b);
  set({
    status: "loading",
    fileNames: entries.map((e) => e.name),
    progress: 0,
    phase: "compile_wasm",
    completedCount: 0,
    inFlightCount: 0,
    totalCount: entries.length,
    error: null,
    ranks,
  });

  const tasks: WorkerTask[] = entries.map((e) => ({
    rank: extractRank(e.name),
    getBuffer: e.reader,
  }));

  const rankData = new Map<number, RankData>();
  let firstDone = false;

  // Throttle rank flushes: collect a burst of completions and emit one
  // React commit per ~50ms instead of one per rank. Progress still ticks
  // smoothly via the onProgress callback; only the heavy rankData update
  // is batched. 32 ranks that finish over ~5s → ~8-10 commits instead of 32.
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_DEBOUNCE_MS = 150;
  const scheduleFlush = () => {
    if (!firstDone) {
      // Emit the first rank synchronously so the dashboard paints asap.
      firstDone = true;
      set({ status: "ready", rankData: new Map(rankData) });
      return;
    }
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      set({ rankData: new Map(rankData) });
    }, FLUSH_DEBOUNCE_MS);
  };

  // Terminate any previous pool before starting a new load.
  if (activePool) activePool.terminate();

  const pool = createWorkerPool(
    (result: WorkerResult) => {
      rankData.set(result.rank, result.data);
      scheduleFlush();
    },
    (rank, error) => {
      console.error(`[memviz] rank ${rank} failed:`, error);
    },
    (completed, inFlight, total, phase) => {
      set({
        progress: completed / total,
        phase,
        completedCount: completed,
        inFlightCount: inFlight,
        totalCount: total,
      });
    },
  );
  activePool = pool;

  await pool.processAll(tasks);
  // Keep the pool alive — workers still hold per-rank framesCache for
  // on-demand getDetail lookups. Terminated on reset() only.

  if (rankData.size === 0) {
    set({ status: "error", error: "All ranks failed to parse", progress: 1 });
  } else {
    set({ status: "ready", rankData: new Map(rankData), progress: 1 });
  }
}
