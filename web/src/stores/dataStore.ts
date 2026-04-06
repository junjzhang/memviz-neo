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
  TimelineBlocksResponse,
} from "../types/timeline";

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
  loading: boolean;
  error: string | null;

  setCurrentRank: (rank: number) => void;
  fetchRanks: () => Promise<void>;
  fetchRankData: (rank: number) => Promise<void>;
  fetchMultiRankOverview: () => Promise<void>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
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
  loading: false,
  error: null,

  setCurrentRank: (rank: number) => {
    set({ currentRank: rank });
    get().fetchRankData(rank);
  },

  fetchRanks: async () => {
    try {
      const ranks = await fetchJson<number[]>("/api/ranks");
      set({ ranks });
      if (ranks.length > 0) {
        await get().fetchRankData(ranks[0]);
        get().fetchMultiRankOverview();
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchRankData: async (rank: number) => {
    set({ loading: true, error: null, currentRank: rank });
    try {
      const [summary, treemap, segments, topAllocations, timeline, blocksResp] =
        await Promise.all([
          fetchJson<RankSummary>(`/api/summary/${rank}`),
          fetchJson<TreemapNode>(`/api/treemap/${rank}`),
          fetchJson<SegmentInfo[]>(`/api/segments/${rank}`),
          fetchJson<TopAllocation[]>(`/api/top_allocations/${rank}?limit=100`),
          fetchJson<TimelineData>(`/api/timeline/${rank}`),
          fetchJson<TimelineBlocksResponse>(`/api/timeline_blocks/${rank}`),
        ]);
      set({
        summary,
        treemap,
        segments,
        topAllocations,
        timeline,
        timelineBlocks: blocksResp.blocks,
        loading: false,
      });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  fetchMultiRankOverview: async () => {
    try {
      const data = await fetchJson<RankSummary[]>("/api/multi_rank_overview");
      set({ multiRankOverview: data });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
