import { create } from "zustand";
import type { RankData } from "../compute";
import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation } from "../types/snapshot";
import type { Anomaly } from "../compute/anomalies";
import { detectAnomalies } from "../compute/anomalies";
import { createWorkerPool, type WorkerResult, type WorkerTask } from "../compute/workerPool";
import { STRIP_PALETTE_RGB } from "../views/glRenderer";

type FileReader = () => Promise<ArrayBuffer>;

interface FileState {
  status: "idle" | "loading" | "ready" | "error";
  fileNames: string[];
  progress: number;
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

function parseWorkerResult(json: string, _rank: number): RankData {
  const raw = JSON.parse(json);
  const summary: RankSummary = raw.summary;
  const allocations = (raw.alloc_details || []).map((a: any) => ({
    addr: a.addr, size: a.size, alloc_us: a.alloc_us,
    free_requested_us: a.free_requested_us, free_us: a.free_us,
    top_frame: a.top_frame, frames: a.frames,
  }));
  const anomalies: Anomaly[] = detectAnomalies(allocations, raw.timeline.time_max);

  // Build treemap from segments
  const segments: SegmentInfo[] = (raw.segments || []).map((s: any) => ({
    address: s.address, total_size: s.total_size, allocated_size: s.allocated_size,
    segment_type: s.segment_type, blocks: s.blocks || [],
  }));
  segments.sort((a: SegmentInfo, b: SegmentInfo) => b.total_size - a.total_size);

  const topAllocations: TopAllocation[] = [];
  const treemapTypeMap = new Map<string, TreemapNode[]>();
  for (const seg of raw.segments || []) {
    const segChildren: TreemapNode[] = [];
    let smallTotal = 0;
    for (const b of seg.blocks || []) {
      if (b.state !== "active_allocated") continue;
      if (b.size >= 1048576) {
        segChildren.push({ name: b.top_frame || `0x${b.address.toString(16)}`, size: b.size, address: b.address, state: b.state, top_frame: b.top_frame });
        topAllocations.push({ address: b.address, size: b.size, source: b.top_frame, segment_type: seg.segment_type });
      } else {
        smallTotal += b.size;
      }
    }
    if (smallTotal > 0) segChildren.push({ name: "(small blocks)", size: smallTotal });
    if (segChildren.length === 0) continue;
    segChildren.sort((a: TreemapNode, b: TreemapNode) => b.size - a.size);
    const segNode: TreemapNode = { name: `seg 0x${seg.address.toString(16)}`, size: segChildren.reduce((s: number, c: TreemapNode) => s + c.size, 0), address: seg.address, children: segChildren };
    const bucket = treemapTypeMap.get(seg.segment_type) ?? [];
    bucket.push(segNode);
    treemapTypeMap.set(seg.segment_type, bucket);
  }
  const rootChildren: TreemapNode[] = [];
  for (const [segType, segs] of [...treemapTypeMap.entries()].sort()) {
    segs.sort((a: TreemapNode, b: TreemapNode) => b.size - a.size);
    rootChildren.push({ name: segType, size: segs.reduce((s: number, c: TreemapNode) => s + c.size, 0), children: segs });
  }
  rootChildren.sort((a: TreemapNode, b: TreemapNode) => b.size - a.size);
  const treemap: TreemapNode = { name: "GPU Memory", size: rootChildren.reduce((s: number, c: TreemapNode) => s + c.size, 0), children: rootChildren };
  topAllocations.sort((a: TopAllocation, b: TopAllocation) => b.size - a.size);

  // Pre-pack strip buffer for WebGL — do the O(N) iteration once at load,
  // not on every rank switch. Also compute maxBytesFull for fast-path.
  //
  // IMPORTANT: subtract time_min before storing as Float32. Real PyTorch traces
  // use absolute Unix timestamps (~1.77e15 us), which collapse to 0-width quads
  // when stored as Float32 (mantissa can't distinguish microsecond-scale diffs).
  const blocks = raw.blocks as { strips: { t_start: number; t_end: number; y_offset: number }[]; size: number; idx: number }[];
  const timeOrigin: number = raw.timeline.time_min;
  let stripCount = 0;
  let maxBytesFull = 0;
  for (const b of blocks) {
    stripCount += b.strips.length;
    for (const s of b.strips) {
      const t = s.y_offset + b.size;
      if (t > maxBytesFull) maxBytesFull = t;
    }
  }
  const stripBuffer = new Float32Array(stripCount * 7);
  let off = 0;
  for (const block of blocks) {
    const [r, g, bl] = STRIP_PALETTE_RGB[block.idx % STRIP_PALETTE_RGB.length];
    const sz = block.size;
    for (const strip of block.strips) {
      stripBuffer[off++] = strip.t_start - timeOrigin;
      stripBuffer[off++] = strip.t_end - timeOrigin;
      stripBuffer[off++] = strip.y_offset;
      stripBuffer[off++] = sz;
      stripBuffer[off++] = r;
      stripBuffer[off++] = g;
      stripBuffer[off++] = bl;
    }
  }

  return {
    summary,
    treemap,
    segments,
    topAllocations: topAllocations.slice(0, 100),
    timeline: {
      usage_series: [],
      annotations: [],
      time_min: raw.timeline.time_min,
      time_max: raw.timeline.time_max,
      peak_bytes: raw.timeline.peak_bytes,
      allocation_count: raw.timeline.allocation_count,
    },
    timelineBlocks: raw.blocks,
    allocations,
    anomalies,
    stripBuffer,
    stripCount,
    maxBytesFull: (maxBytesFull || raw.timeline.peak_bytes) * 1.1,
  };
}

export const useFileStore = create<FileState>((set) => ({
  status: "idle",
  fileNames: [],
  progress: 0,
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

  reset: () => set({ status: "idle", fileNames: [], progress: 0, error: null, ranks: [], rankData: new Map() }),
}));

async function loadAllParallel(
  entries: { name: string; reader: FileReader }[],
  set: (partial: Partial<FileState>) => void,
) {
  entries.sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) { set({ status: "error", error: "No .pickle files found" }); return; }

  const ranks = entries.map((e) => extractRank(e.name)).sort((a, b) => a - b);
  set({ status: "loading", fileNames: entries.map((e) => e.name), progress: 0, error: null, ranks });

  const tasks: WorkerTask[] = entries.map((e) => ({
    rank: extractRank(e.name),
    getBuffer: e.reader,
  }));

  const rankData = new Map<number, RankData>();
  let firstDone = false;

  const pool = createWorkerPool(
    (result: WorkerResult) => {
      const data = parseWorkerResult(result.json, result.rank);
      rankData.set(result.rank, data);

      // Only push to React on first rank (show UI immediately)
      if (!firstDone) {
        firstDone = true;
        set({ status: "ready", rankData: new Map(rankData) });
      }
    },
    (rank, error) => {
      console.error(`[memviz] rank ${rank} failed:`, error);
    },
    (completed, total) => {
      set({ progress: completed / total });
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
