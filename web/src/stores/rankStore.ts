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
  /** Max total_reserved across all loaded ranks. */
  maxReserved: number;
  /** Max peak_bytes across all loaded ranks — this is what we scale
   *  rank-selector cells against, since peak is the OOM-relevant
   *  worst moment rather than the snapshot's end-of-window state. */
  maxPeak: number;
  setSummary: (rank: number, s: RankSummary) => void;
  clearAll: () => void;
}

export const useRankSummaries = create<RankSummariesState>((set) => ({
  summaries: {},
  maxReserved: 1,
  maxPeak: 1,
  setSummary: (rank, s) => set((state) => {
    const peak = s.peak_bytes ?? s.active_bytes;
    return {
      summaries: { ...state.summaries, [rank]: s },
      maxReserved: s.total_reserved > state.maxReserved ? s.total_reserved : state.maxReserved,
      maxPeak: peak > state.maxPeak ? peak : state.maxPeak,
    };
  }),
  clearAll: () => set({ summaries: {}, maxReserved: 1, maxPeak: 1 }),
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
