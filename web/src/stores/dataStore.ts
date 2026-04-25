import { create } from "zustand";
import type {
  RankSummary,
  SegmentInfo,
  TopAllocation,
  FrameRecord,
} from "../types/snapshot";
import type {
  TimelineData,
  TimelineAlloc,
  AllocationDetail,
} from "../types/timeline";
import type { RankData, Anomaly, SegmentRow, FlameData } from "../compute";
import { getActivePool } from "./fileStore";
import { formatTopFrame } from "../utils";

// Main-thread "current rank" store. We hold the full RankData only for
// the currently-selected rank (plus a small LRU for recently-visited
// ones). Everything else lives in its owning layout worker. Rank
// switching triggers workerPool.requestFull(rank) which structured-
// clones the RankData back to main. ~20-50ms per switch.

interface DataState {
  currentRank: number;
  summary: RankSummary | null;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  timeline: TimelineData | null;
  timelineAllocs: TimelineAlloc[];
  anomalies: Anomaly[];
  framePool: FrameRecord[];
  /** Per-alloc stack pools — TopAllocations filters by frame using these. */
  stackPool: Uint32Array[];
  timelineStripBuffer: Float32Array | null;
  /** Same strips, but t-columns replaced by event indices (for "event"
   *  X-axis mode). parseRank produces both up front. */
  timelineStripBufferEvent: Float32Array | null;
  /** Sorted unique event times (relative to time_min) — bridge between
   *  time-μs and event-index axes. length = number of events. */
  eventTimes: Float64Array | null;
  timelineStripCount: number;
  timelineMaxBytesFull: number;
  /** Per-allocator-segment rows for the SegmentTimeline view. */
  segmentRows: SegmentRow[];
  /** Call-stack pressure flamegraph for the current rank. */
  flame: FlameData | null;
  /** X-axis unit. "time" uses absolute microseconds, "event" numbers
   *  events 0..N-1 so dense allocation phases stretch out. */
  xAxisMode: "time" | "event";
  setXAxisMode: (mode: "time" | "event") => void;
  /** Loading while waiting for a requestFull. Different from file load. */
  switching: boolean;
  error: string | null;
  focusedAddr: number | null;
  focusRange: [number, number] | null;
  /** Identifier of the allocation currently clicked in the Memory
   *  Timeline. `addr` alone is ambiguous because PyTorch reuses GPU
   *  addresses after free, so we key on (addr, alloc_us) which is
   *  unique across the trace. Null = nothing selected. */
  selectedAlloc: { addr: number; alloc_us: number } | null;
  setSelectedAlloc: (a: { addr: number; alloc_us: number } | null) => void;

  /** Underlying RankData for the current rank (needed for getDetail). */
  _currentData: RankData | null;

  setCurrentRank: (rank: number) => Promise<void>;
  getDetail: (rank: number, addr: number, alloc_us: number) => AllocationDetail | null;
  focusAnomaly: (anomaly: Anomaly) => void;
  clearFocus: () => void;
  resetData: () => void;
}

/** Rank data → slice of DataState. Pass null to get the empty state
 *  (used by resetData). Transient fields (focus, selection, switching)
 *  always reset when this runs. */
function applyRankData(data: RankData | null, rank: number): Partial<DataState> {
  return {
    currentRank: rank,
    summary: data?.summary ?? null,
    segments: data?.segments ?? [],
    topAllocations: data?.topAllocations ?? [],
    timeline: data?.timeline ?? null,
    timelineAllocs: data?.timelineAllocs ?? [],
    anomalies: data?.anomalies ?? [],
    framePool: data?.framePool ?? [],
    stackPool: data?.stackPool ?? [],
    timelineStripBuffer: data?.stripBuffer ?? null,
    timelineStripBufferEvent: data?.stripBufferEvent ?? null,
    eventTimes: data?.eventTimes ?? null,
    timelineStripCount: data?.stripCount ?? 0,
    timelineMaxBytesFull: data?.maxBytesFull ?? 0,
    segmentRows: data?.segmentRows ?? [],
    flame: data?.flame ?? null,
    focusedAddr: null,
    focusRange: null,
    selectedAlloc: null,
    switching: false,
    _currentData: data,
  };
}

// De-dupe concurrent setCurrentRank calls for the same rank.
let inflight: { rank: number; promise: Promise<void> } | null = null;

export const useDataStore = create<DataState>((set, get) => ({
  currentRank: 0,
  summary: null,
  segments: [],
  topAllocations: [],
  timeline: null,
  timelineAllocs: [],
  anomalies: [],
  framePool: [],
  stackPool: [],
  timelineStripBuffer: null,
  timelineStripBufferEvent: null,
  eventTimes: null,
  timelineStripCount: 0,
  timelineMaxBytesFull: 0,
  segmentRows: [],
  flame: null,
  // Default matches PyTorch's Active Memory Timeline: X axis counts
  // alloc/free events, so dense training phases aren't compressed by
  // optimizer-step idle gaps. Switch to "time" to see real μs latency.
  xAxisMode: "event" as const,
  setXAxisMode: (mode: "time" | "event") => set({ xAxisMode: mode }),
  switching: false,
  error: null,
  focusedAddr: null,
  focusRange: null,
  selectedAlloc: null,
  setSelectedAlloc: (a) => set({ selectedAlloc: a }),
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

  getDetail: (rank: number, addr: number, alloc_us: number): AllocationDetail | null => {
    // Detail resolution uses the currently-loaded rank's data. If user
    // requests detail for a rank that isn't current, they'd have had to
    // be viewing it (we only call getDetail from hover/click on the
    // active rank's timeline / treemap).
    const rd = get()._currentData;
    if (!rd || rd.summary.rank !== rank) return null;
    // PyTorch reuses GPU addresses; key the lookup on the (addr,alloc_us)
    // pair so we return the specific alloc the user clicked, not some
    // later alloc that happened to land at the same address.
    const entry = rd.stackByIdentity.get(`${addr}-${alloc_us}`);
    if (!entry) return null;
    const stack = rd.stackPool[entry.stack_idx];
    const frames = stack
      ? Array.from(stack, (fi) => {
          const f = rd.framePool[fi];
          return f ? { name: f.name, filename: f.filename, line: f.line }
                   : { name: "", filename: "", line: 0 };
        })
      : [];
    const topFrame = formatTopFrame(entry.top_frame_idx, rd.framePool);
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
    // Symmetric window centered on the alloc: for pending_free we span
    // [alloc, free] with 20% padding on each side; for leak/alive we
    // pick a ±half-window around alloc. Previously tMax leaked alloc +
    // 3×padding which pushed the alloc to the far-left 25% of the
    // window — visually felt like "jumping far away" in event mode.
    let tMin: number, tMax: number;
    if (anomaly.free_us > 0) {
      const span = anomaly.free_us - anomaly.alloc_us;
      const pad = Math.max(100000, span * 0.2);
      tMin = anomaly.alloc_us - pad;
      tMax = anomaly.free_us + pad;
    } else {
      const half = 500000; // 500ms half-window
      tMin = anomaly.alloc_us - half;
      tMax = anomaly.alloc_us + half;
    }
    set({ focusedAddr: anomaly.addr, focusRange: [tMin, tMax] });
  },

  clearFocus: () => set({ focusedAddr: null, focusRange: null }),

  resetData: () => {
    inflight = null;
    set({ ...applyRankData(null, 0), error: null });
  },
}));
