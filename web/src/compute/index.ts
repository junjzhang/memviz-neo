import type { RankSummary, SegmentInfo, TopAllocation, FrameRecord } from "../types/snapshot";
import type { TimelineData, TimelineAlloc } from "../types/timeline";
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

/** One segment row worth of data for the SegmentTimeline view.
 *  Allocs are the subset of top-N allocations whose addr lives inside this
 *  segment's [address, address+totalSize) range. */
export interface SegmentAlloc {
  addr: number;
  offsetInSeg: number;
  size: number;
  alloc_us: number;
  /** -1 means still alive at snapshot (draw to timeline_end). */
  free_us: number;
  top_frame_idx: number;
  /** [r, g, b] in 0..1; same value the Memory Timeline uses for this alloc. */
  color: [number, number, number];
}

export interface SegmentRow {
  segmentAddr: number;
  segmentType: string;
  totalSize: number;
  allocs: SegmentAlloc[];
}

/** One flame-graph rectangle. Coordinates are in weight units (bytes·μs
 *  of memory pressure); the renderer converts to pixels using totalWeight. */
export interface FlameNode {
  /** Frame pool index; -1 for the synthetic root ("all"). */
  frameIdx: number;
  depth: number;
  weight: number;
  xStart: number;
}

export interface FlameData {
  nodes: FlameNode[];
  totalWeight: number;
  maxDepth: number;
}

export interface RankData {
  summary: RankSummary;
  segments: SegmentInfo[];
  topAllocations: TopAllocation[];
  timeline: TimelineData;
  timelineAllocs: TimelineAlloc[];
  anomalies: Anomaly[];
  // Pre-packed GPU buffer for WebGL instanced rendering.
  // 7 floats per strip: (t_start, t_end, y_offset, height, r, g, b)
  stripBuffer: Float32Array;
  /** Same shape as stripBuffer, but with t_start/t_end replaced by
   *  event indices (position in `eventTimes`). Lets the timeline view
   *  switch between "actual μs" and "event ordinal" X axis by swapping
   *  GPU buffers, no re-layout needed. */
  stripBufferEvent: Float32Array;
  stripCount: number;
  /** Sorted unique alloc/free event times for this rank, relative to
   *  timeline.time_min. Used for (time_us ↔ event_idx) mapping when the
   *  user toggles the X axis mode. */
  eventTimes: Float64Array;
  // Per-rank max bytes (for full-view fast path, avoids iterating blocks)
  maxBytesFull: number;
  /** Per-segment allocator row data for the SegmentTimeline view. Sorted
   *  by totalSize desc so the biggest cached segments render on top. */
  segmentRows: SegmentRow[];
  /** Flame graph: call-stack → memory pressure aggregate. */
  flame: FlameData;
  // Interned frame records and stacks (stacks point into framePool).
  // Any top_frame_idx / source_idx in segments / blocks / allocations /
  // anomalies refers into framePool. Stack traces for the detail panel
  // come from stackPool[allocation.stack_idx].map(i => framePool[i]).
  framePool: FrameRecord[];
  stackPool: Uint32Array[];
  /** Map "addr-alloc_us" → stack for top-rendered allocations (used by
   *  getDetail). Key is a string tuple because PyTorch reuses GPU
   *  addresses, so `addr` alone can't uniquely identify an alloc. */
  stackByIdentity: Map<string, { stack_idx: number; size: number; alloc_us: number; free_us: number; top_frame_idx: number }>;
}

export type { Anomaly } from "./anomalies";
