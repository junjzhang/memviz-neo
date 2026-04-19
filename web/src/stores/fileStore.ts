import { create } from "zustand";
import type { RankData } from "../compute";
import { createWorkerPool, type WorkerResult, type WorkerTask, type LoadPhase } from "../compute/workerPool";

type FileReader = () => Promise<ArrayBuffer>;

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

  reset: () =>
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
    }),
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

  const pool = createWorkerPool(
    (result: WorkerResult) => {
      // Worker already parsed into RankData; main thread only does the Map.set.
      rankData.set(result.rank, result.data);

      // Only push to React on first rank (show UI immediately)
      if (!firstDone) {
        firstDone = true;
        set({ status: "ready", rankData: new Map(rankData) });
      }
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

  await pool.processAll(tasks);
  pool.terminate();
  if (rankData.size === 0) {
    set({ status: "error", error: "All ranks failed to parse", progress: 1 });
  } else {
    // Final flush: all ranks done, push complete data to React once
    set({ status: "ready", rankData: new Map(rankData), progress: 1 });
  }
}
