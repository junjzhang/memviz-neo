import { create } from "zustand";
import type {
  RankSummary,
  TreemapNode,
  SegmentInfo,
  TopAllocation,
} from "../types/snapshot";
import type {
  TimelineData,
  TimelineBlock,
  AllocationDetail,
} from "../types/timeline";
import type { RankData, Anomaly } from "../compute";
import { getActivePool } from "./fileStore";

interface DataState {
  ranks: number[];
  currentRank: number;
  summary: RankSummary | null;
  treemap: TreemapNode | null;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  multiRankOverview: RankSummary[];
  timeline: TimelineData | null;
  timelineBlocks: TimelineBlock[];
  anomalies: Anomaly[];
  // Pre-packed WebGL strip data — zero-copy on rank switch
  timelineStripBuffer: Float32Array | null;
  timelineStripCount: number;
  timelineMaxBytesFull: number;
  loading: boolean;
  error: string | null;
  focusedAddr: number | null;
  focusRange: [number, number] | null;

  _rankCache: Map<number, RankData>;

  setCurrentRank: (rank: number) => void;
  loadFromFiles: (rankData: Map<number, RankData>) => void;
  getDetail: (rank: number, addr: number) => Promise<AllocationDetail | null>;
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
    timelineStripBuffer: data.stripBuffer,
    timelineStripCount: data.stripCount,
    timelineMaxBytesFull: data.maxBytesFull,
    focusedAddr: null,
    focusRange: null,
    loading: false,
  };
}

export const useDataStore = create<DataState>((set, get) => ({
  ranks: [],
  currentRank: 0,
  summary: null,
  treemap: null,
  segments: [],
  topAllocations: [],
  multiRankOverview: [],
  timeline: null,
  timelineBlocks: [],
  anomalies: [],
  timelineStripBuffer: null,
  timelineStripCount: 0,
  timelineMaxBytesFull: 0,
  loading: false,
  error: null,
  focusedAddr: null,
  focusRange: null,
  _rankCache: new Map(),

  setCurrentRank: (rank: number) => {
    const data = get()._rankCache.get(rank);
    if (!data) return;
    set(applyRankData(data, rank));
  },

  loadFromFiles: (rankData: Map<number, RankData>) => {
    const state = get();
    const parsedRanks = [...rankData.keys()].sort((a, b) => a - b);

    const isNewDataset =
      !state.summary ||
      state._rankCache !== rankData && !state._rankCache.has(parsedRanks[0]) ||
      !rankData.has(state.currentRank);

    if (isNewDataset) {
      const first = parsedRanks[0];
      const data = rankData.get(first)!;
      set({
        ranks: parsedRanks,
        multiRankOverview: parsedRanks.map((r) => rankData.get(r)!.summary),
        _rankCache: rankData,
        error: null,
        ...applyRankData(data, first),
      });
    } else {
      const needsOverview = parsedRanks.length !== state.ranks.length;
      set({
        ranks: parsedRanks,
        ...(needsOverview ? { multiRankOverview: parsedRanks.map((r) => rankData.get(r)!.summary) } : {}),
        _rankCache: rankData,
      });
    }
  },

  getDetail: async (rank: number, addr: number): Promise<AllocationDetail | null> => {
    // All allocation detail (size/time/top_frame + frames) is kept worker-
    // local. Fetch the complete record in a single round-trip.
    const pool = getActivePool();
    if (!pool) return null;
    return pool.getDetail(rank, addr);
  },

  focusAnomaly: (anomaly: Anomaly) => {
    const padding = Math.max(100000, (anomaly.free_us > 0 ? anomaly.free_us - anomaly.alloc_us : 1000000) * 0.3);
    const tMin = anomaly.alloc_us - padding;
    const tMax = (anomaly.free_us > 0 ? anomaly.free_us : anomaly.alloc_us + padding * 2) + padding;
    set({ focusedAddr: anomaly.addr, focusRange: [tMin, tMax] });
  },

  clearFocus: () => set({ focusedAddr: null, focusRange: null }),

  resetData: () => set({
    ranks: [],
    currentRank: 0,
    summary: null,
    treemap: null,
    segments: [],
    topAllocations: [],
    multiRankOverview: [],
    timeline: null,
    timelineBlocks: [],
    anomalies: [],
    timelineStripBuffer: null,
    timelineStripCount: 0,
    timelineMaxBytesFull: 0,
    focusedAddr: null,
    focusRange: null,
    _rankCache: new Map(),
  }),
}));
