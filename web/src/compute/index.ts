import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation, FrameRecord } from "../types/snapshot";
import type { TimelineData, TimelineBlock } from "../types/timeline";
import type { Anomaly } from "./anomalies";

/**
 * Worker-internal allocation record used during parse/anomaly detection.
 * Never crosses the message boundary — main thread reads via index pools.
 */
export interface Allocation {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number;
  free_us: number;
  top_frame_idx: number;
  stack_idx: number;
}

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
  // Interned frame records and stacks (stacks point into framePool).
  // Any top_frame_idx / source_idx in segments / blocks / allocations /
  // anomalies refers into framePool. Stack traces for the detail panel
  // come from stackPool[allocation.stack_idx].map(i => framePool[i]).
  framePool: FrameRecord[];
  stackPool: Uint32Array[];
  /** Map addr → stack_idx for top-rendered allocations (used by getDetail). */
  stackByAddr: Map<number, { stack_idx: number; size: number; alloc_us: number; free_us: number; top_frame_idx: number }>;
}

export type { Anomaly } from "./anomalies";
