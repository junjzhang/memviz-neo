import { create } from "zustand";
import type {
  RankSummary,
  TreemapNode,
  SegmentInfo,
  TopAllocation,
  FrameRecord,
} from "../types/snapshot";
import type {
  TimelineData,
  TimelineBlock,
  AllocationDetail,
} from "../types/timeline";
import type { RankData, Anomaly, SegmentRow, FlameData } from "../compute";
import { getActivePool } from "./fileStore";

// Main-thread "current rank" store. We hold the full RankData only for
// the currently-selected rank (plus a small LRU for recently-visited
// ones). Everything else lives in its owning layout worker. Rank
// switching triggers workerPool.requestFull(rank) which structured-
// clones the RankData back to main. ~20-50ms per switch.

interface DataState {
  currentRank: number;
  summary: RankSummary | null;
  treemap: TreemapNode | null;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  timeline: TimelineData | null;
  timelineBlocks: TimelineBlock[];
  anomalies: Anomaly[];
  framePool: FrameRecord[];
  timelineStripBuffer: Float32Array | null;
  timelineStripCount: number;
  timelineMaxBytesFull: number;
  /** Per-allocator-segment rows for the SegmentTimeline view. */
  segmentRows: SegmentRow[];
  /** Call-stack pressure flamegraph for the current rank. */
  flame: FlameData | null;
  /** Loading while waiting for a requestFull. Different from file load. */
  switching: boolean;
  error: string | null;
  focusedAddr: number | null;
  focusRange: [number, number] | null;

  /** Underlying RankData for the current rank (needed for getDetail). */
  _currentData: RankData | null;

  setCurrentRank: (rank: number) => Promise<void>;
  getDetail: (rank: number, addr: number) => AllocationDetail | null;
  focusAnomaly: (anomaly: Anomaly) => void;
  clearFocus: () => void;
  resetData: () => void;
}

function applyRankData(data: RankData, rank: number): Partial<DataState> {
  return {
    currentRank: rank,
    summary: data.summary,
    treemap: data.treemap,
    segments: data.segments,
    topAllocations: data.topAllocations,
    timeline: data.timeline,
    timelineBlocks: data.timelineBlocks,
    anomalies: data.anomalies,
    framePool: data.framePool,
    timelineStripBuffer: data.stripBuffer,
    timelineStripCount: data.stripCount,
    timelineMaxBytesFull: data.maxBytesFull,
    segmentRows: data.segmentRows,
    flame: data.flame,
    focusedAddr: null,
    focusRange: null,
    switching: false,
    _currentData: data,
  };
}

const emptyState: Partial<DataState> = {
  currentRank: 0,
  summary: null,
  treemap: null,
  segments: [],
  topAllocations: [],
  timeline: null,
  timelineBlocks: [],
  anomalies: [],
  framePool: [],
  timelineStripBuffer: null,
  timelineStripCount: 0,
  timelineMaxBytesFull: 0,
  segmentRows: [],
  flame: null,
  switching: false,
  focusedAddr: null,
  focusRange: null,
  _currentData: null,
};

// De-dupe concurrent setCurrentRank calls for the same rank.
let inflight: { rank: number; promise: Promise<void> } | null = null;

export const useDataStore = create<DataState>((set, get) => ({
  currentRank: 0,
  summary: null,
  treemap: null,
  segments: [],
  topAllocations: [],
  timeline: null,
  timelineBlocks: [],
  anomalies: [],
  framePool: [],
  timelineStripBuffer: null,
  timelineStripCount: 0,
  timelineMaxBytesFull: 0,
  segmentRows: [],
  flame: null,
  switching: false,
  error: null,
  focusedAddr: null,
  focusRange: null,
  _currentData: null,

  setCurrentRank: async (rank: number) => {
    const current = get();
    if (current.currentRank === rank && current._currentData !== null) return;
    if (inflight && inflight.rank === rank) return inflight.promise;

    const pool = getActivePool();
    if (!pool) return;

    set({ switching: true, currentRank: rank });

    const promise = (async () => {
      try {
        const data = await pool.requestFull(rank);
        set(applyRankData(data, rank));
      } catch (err: any) {
        set({ switching: false, error: String(err) });
      } finally {
        if (inflight && inflight.rank === rank) inflight = null;
      }
    })();

    inflight = { rank, promise };
    return promise;
  },

  getDetail: (rank: number, addr: number): AllocationDetail | null => {
    // Detail resolution uses the currently-loaded rank's data. If user
    // requests detail for a rank that isn't current, they'd have had to
    // be viewing it (we only call getDetail from hover/click on the
    // active rank's timeline / treemap).
    const rd = get()._currentData;
    if (!rd || rd.summary.rank !== rank) return null;
    const entry = rd.stackByAddr.get(addr);
    if (!entry) return null;
    const stack = rd.stackPool[entry.stack_idx];
    const frames = stack
      ? Array.from(stack, (fi) => {
          const f = rd.framePool[fi];
          return f ? { name: f.name, filename: f.filename, line: f.line }
                   : { name: "", filename: "", line: 0 };
        })
      : [];
    const topFrame =
      entry.top_frame_idx >= 0 && rd.framePool[entry.top_frame_idx]
        ? (() => {
            const f = rd.framePool[entry.top_frame_idx];
            const n = f.name.split("(")[0].split("<")[0].trim();
            if (f.filename.includes(".py")) {
              const i = f.filename.lastIndexOf("/");
              const short = i >= 0 ? f.filename.slice(i + 1) : f.filename;
              return `${n} @ ${short}:${f.line}`;
            }
            return n.length > 60 ? n.slice(0, 57) + "..." : n;
          })()
        : "";
    return {
      addr,
      size: entry.size,
      alloc_us: entry.alloc_us,
      free_us: entry.free_us,
      top_frame: topFrame,
      frames,
    };
  },

  focusAnomaly: (anomaly: Anomaly) => {
    const padding = Math.max(100000, (anomaly.free_us > 0 ? anomaly.free_us - anomaly.alloc_us : 1000000) * 0.3);
    const tMin = anomaly.alloc_us - padding;
    const tMax = (anomaly.free_us > 0 ? anomaly.free_us : anomaly.alloc_us + padding * 2) + padding;
    set({ focusedAddr: anomaly.addr, focusRange: [tMin, tMax] });
  },

  clearFocus: () => set({ focusedAddr: null, focusRange: null }),

  resetData: () => {
    inflight = null;
    set({ ...emptyState, error: null });
  },
}));
