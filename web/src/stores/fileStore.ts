import { create } from "zustand";
import {
  createWorkerPool,
  type WorkerPool,
  type WorkerTask,
  type LoadPhase,
  type ProgressSnapshot,
  type RankSummary as WorkerRankSummary,
} from "../compute/workerPool";
import { setSummary as cacheSetSummary, clearSummaries } from "./rankStore";

type FileReader = () => Promise<ArrayBuffer>;

// Active pool lives until the next dataset is loaded or reset is called.
// Kept around so rank-switch requestFull() can talk to the worker that
// holds the target rank's data.
let activePool: WorkerPool | null = null;

export function getActivePool(): WorkerPool | null {
  return activePool;
}

const HW_CONC = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
export const WORKER_COUNT_MAX = Math.max(4, Math.min(HW_CONC, 16));

/**
 * Load a numeric preference from localStorage. Reads the key, rejects
 * anything that fails `validate`, and falls back to `fallback`.
 * `save` writes clamped values back; both handle missing localStorage
 * (SSR / privacy mode) and quota errors gracefully.
 */
function persistentNumber(key: string, fallback: number, validate: (n: number) => boolean) {
  const load = (): number => {
    if (typeof localStorage === "undefined") return fallback;
    const raw = localStorage.getItem(key);
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && validate(n) ? n : fallback;
  };
  const save = (n: number) => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(key, String(n)); } catch { /* ignore quota */ }
  };
  return { load, save };
}

const workerCountPref = persistentNumber(
  "memviz.workerCount",
  Math.min(HW_CONC, 8),
  (n) => n >= 1 && n <= WORKER_COUNT_MAX,
);

// layout_limit passed to WASM parse_intern. 0 = keep all allocations.
// Small values (3k) drop mid-sized transient allocations and flatten
// the optimizer-step saw-tooth pattern; 20k usually covers full FSDP
// iterations; 0 is exact at the cost of more strips.
export const LAYOUT_LIMIT_OPTIONS: { value: number; label: string }[] = [
  { value: 3000, label: "3k" },
  { value: 10000, label: "10k" },
  { value: 20000, label: "20k" },
  { value: 0, label: "all" },
];

const layoutLimitPref = persistentNumber(
  "memviz.layoutLimit",
  20000,
  (n) => n >= 0,
);

interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  fileNames: string[];
  progress: number;
  phase: LoadPhase | "idle";
  completedCount: number;
  inFlightCount: number;
  totalCount: number;
  inFlightRanks: number[];
  poolSize: number;
  workerCount: number;
  layoutLimit: number;
  error: string | null;
  ranks: number[];

  openDirectory: () => Promise<void>;
  openFiles: (files: FileList) => Promise<void>;
  setWorkerCount: (n: number) => void;
  setLayoutLimit: (n: number) => void;
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
  inFlightRanks: [],
  poolSize: 0,
  workerCount: workerCountPref.load(),
  layoutLimit: layoutLimitPref.load(),
  error: null,
  ranks: [],

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

  setWorkerCount: (n: number) => {
    const clamped = Math.max(1, Math.min(n, WORKER_COUNT_MAX));
    workerCountPref.save(clamped);
    set({ workerCount: clamped });
  },

  setLayoutLimit: (n: number) => {
    const v = Math.max(0, Math.floor(n));
    layoutLimitPref.save(v);
    set({ layoutLimit: v });
  },

  reset: () => {
    if (activePool) {
      activePool.terminate();
      activePool = null;
    }
    clearSummaries();
    set({
      status: "idle",
      fileNames: [],
      progress: 0,
      phase: "idle",
      completedCount: 0,
      inFlightCount: 0,
      totalCount: 0,
      inFlightRanks: [],
      poolSize: 0,
      error: null,
      ranks: [],
    });
  },
}));

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as any).__memvizLoadUrls = async (urls: string[]) => {
    const entries = await Promise.all(
      urls.map(async (url) => {
        const name = url.split("/").pop() || url;
        const buf = await (await fetch(url)).arrayBuffer();
        return { name, reader: async () => buf };
      }),
    );
    const set = (partial: Partial<FileState>) => useFileStore.setState(partial);
    await loadAllParallel(entries, set);
  };
}

async function loadAllParallel(
  entries: { name: string; reader: FileReader }[],
  set: (partial: Partial<FileState>) => void,
) {
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) { set({ status: "error", error: "No .pickle files found" }); return; }

  const ranks = entries.map((e) => extractRank(e.name)).sort((a, b) => a - b);
  clearSummaries();
  set({
    status: "loading",
    fileNames: entries.map((e) => e.name),
    progress: 0,
    phase: "compile_wasm",
    completedCount: 0,
    inFlightCount: 0,
    totalCount: entries.length,
    inFlightRanks: [],
    poolSize: 0,
    error: null,
    ranks,
  });

  const tasks: WorkerTask[] = entries.map((e) => ({
    rank: extractRank(e.name),
    getBuffer: e.reader,
  }));

  let firstDone = false;

  if (activePool) activePool.terminate();

  const desiredWorkers = useFileStore.getState().workerCount;
  const pool = createWorkerPool(
    (rank: number, summary: WorkerRankSummary) => {
      // Summary-only push during load: ~64 bytes per rank. Cheap
      // structured clone, cheap selector comparisons on main.
      cacheSetSummary(rank, summary);
      if (!firstDone) {
        firstDone = true;
        set({ status: "ready" });
      }
    },
    (rank, error) => {
      console.error(`[memviz] rank ${rank} failed:`, error);
    },
    (snap: ProgressSnapshot) => {
      set({
        progress: snap.completed / snap.total,
        phase: snap.phase,
        completedCount: snap.completed,
        inFlightCount: snap.inFlight,
        totalCount: snap.total,
        inFlightRanks: snap.inFlightRanks,
        poolSize: snap.poolSize,
      });
    },
    { poolSize: desiredWorkers },
  );
  activePool = pool;

  const layoutLimit = useFileStore.getState().layoutLimit;
  await pool.processAll(tasks, { layoutLimit });

  if (!firstDone) {
    set({ status: "error", error: "All ranks failed to parse", progress: 1 });
  } else {
    set({ progress: 1 });
  }
}
