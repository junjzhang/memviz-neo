import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation } from "../types/snapshot";
import type { TimelineData, TimelineBlock } from "../types/timeline";
import type { Anomaly } from "./anomalies";

/**
 * Worker-side allocation record. Only detectAnomalies consumes this in
 * the worker — it never crosses the message boundary. Use AllocationLite
 * when passing the record back to the main thread via detail lookups.
 */
export interface Allocation {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number;
  free_us: number;
  top_frame: string;
}

export type AllocationLite = Allocation;

export interface RankData {
  summary: RankSummary;
  treemap: TreemapNode;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  timeline: TimelineData;
  timelineBlocks: TimelineBlock[];
  anomalies: Anomaly[];
  // Pre-packed GPU buffer for WebGL instanced rendering.
  // 7 floats per strip: (t_start, t_end, y_offset, height, r, g, b)
  stripBuffer: Float32Array;
  stripCount: number;
  // Per-rank max bytes (for full-view fast path, avoids iterating blocks)
  maxBytesFull: number;
}

export type { Anomaly } from "./anomalies";
