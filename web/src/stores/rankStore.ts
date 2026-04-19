// Lightweight store for per-rank *summary* only. The big RankData for
// each rank stays inside the layout worker — main thread doesn't cache
// it here. During a 128-rank load the worker posts ~64 bytes per rank
// to this store; the dashboard requests the full RankData on demand
// when the user switches to a rank (dataStore.setCurrentRank).
//
// This is the piece that makes loading-time main-thread long tasks
// collapse: the structured-clone-a-whole-RankData-per-flush pathway
// is gone.

import { create } from "zustand";
import type { RankSummary } from "../types/snapshot";

interface RankSummariesState {
  summaries: Record<number, RankSummary>;
  /** Max total_reserved across all loaded ranks. Bumped incrementally
   * when a summary lands so we don't re-scan 128 ranks per flush. */
  maxReserved: number;
  setSummary: (rank: number, s: RankSummary) => void;
  clearAll: () => void;
}

export const useRankSummaries = create<RankSummariesState>((set) => ({
  summaries: {},
  maxReserved: 1,
  setSummary: (rank, s) => set((state) => ({
    summaries: { ...state.summaries, [rank]: s },
    maxReserved: s.total_reserved > state.maxReserved ? s.total_reserved : state.maxReserved,
  })),
  clearAll: () => set({ summaries: {}, maxReserved: 1 }),
}));

export function setSummary(rank: number, s: RankSummary) {
  useRankSummaries.getState().setSummary(rank, s);
}

export function clearSummaries() {
  useRankSummaries.getState().clearAll();
}

export function getSummary(rank: number): RankSummary | undefined {
  return useRankSummaries.getState().summaries[rank];
}
