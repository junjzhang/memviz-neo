import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation } from "../types/snapshot";
import type { TimelineData, TimelineBlock } from "../types/timeline";
import type { Anomaly } from "./anomalies";

/**
 * Light allocation record — no `frames` array. Full stack traces live in
 * the worker's per-rank framesCache and are fetched lazily via the pool's
 * detail channel (see dataStore.getDetail).
 */
export interface Allocation {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number;
  free_us: number;
  top_frame: string;
  /** Always empty on the main thread (worker keeps the real data). */
  frames: { name: string; filename: string; line: number }[];
}

export interface RankData {
  summary: RankSummary;
  treemap: TreemapNode;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  timeline: TimelineData;
  timelineBlocks: TimelineBlock[];
  allocations: Allocation[];
  anomalies: Anomaly[];
  // Pre-packed GPU buffer for WebGL instanced rendering.
  // 7 floats per strip: (t_start, t_end, y_offset, height, r, g, b)
  stripBuffer: Float32Array;
  stripCount: number;
  // Per-rank max bytes (for full-view fast path, avoids iterating blocks)
  maxBytesFull: number;
}

export type { Anomaly } from "./anomalies";
