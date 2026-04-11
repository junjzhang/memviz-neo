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
import { getAllocationDetail, type RankData, type Anomaly, type Allocation } from "../compute";

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
  loading: boolean;
  error: string | null;
  focusedAddr: number | null;
  focusRange: [number, number] | null;

  _rankCache: Map<number, RankData>;
  _allocCache: Map<number, Allocation[]>;

  setCurrentRank: (rank: number) => void;
  loadFromFiles: (rankData: Map<number, RankData>) => void;
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
  loading: false,
  error: null,
  focusedAddr: null,
  focusRange: null,
  _rankCache: new Map(),
  _allocCache: new Map(),

  setCurrentRank: (rank: number) => {
    const data = get()._rankCache.get(rank);
    if (!data) return;
    const ac = new Map(get()._allocCache);
    ac.set(rank, data.allocations);
    set({ ...applyRankData(data, rank), _allocCache: ac });
  },

  loadFromFiles: (rankData: Map<number, RankData>) => {
    const state = get();
    const parsedRanks = [...rankData.keys()].sort((a, b) => a - b);

    // New dataset if:
    //  - nothing loaded yet, OR
    //  - _rankCache reference changed (reset + new load), OR
    //  - currentRank no longer exists in new data
    const isNewDataset =
      !state.summary ||
      state._rankCache !== rankData && !state._rankCache.has(parsedRanks[0]) ||
      !rankData.has(state.currentRank);

    if (isNewDataset) {
      const first = parsedRanks[0];
      const data = rankData.get(first)!;
      const ac = new Map<number, Allocation[]>();
      ac.set(first, data.allocations);
      set({
        ranks: parsedRanks,
        multiRankOverview: parsedRanks.map((r) => rankData.get(r)!.summary),
        _rankCache: rankData,
        _allocCache: ac,
        error: null,
        ...applyRankData(data, first),
      });
    } else {
      // Progressive update in same dataset: only refresh rank list and overview
      const needsOverview = parsedRanks.length !== state.ranks.length;
      set({
        ranks: parsedRanks,
        ...(needsOverview ? { multiRankOverview: parsedRanks.map((r) => rankData.get(r)!.summary) } : {}),
        _rankCache: rankData,
      });
    }
  },

  getDetail: (rank: number, addr: number): AllocationDetail | null => {
    const allocs = get()._allocCache.get(rank);
    if (!allocs) return null;
    return getAllocationDetail(allocs, addr);
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
    focusedAddr: null,
    focusRange: null,
    _rankCache: new Map(),
    _allocCache: new Map(),
  }),
}));
