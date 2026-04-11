import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation } from "../types/snapshot";
import type { TimelineData, TimelineBlock, AllocationDetail } from "../types/timeline";
import type { Anomaly } from "./anomalies";

export interface Allocation {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number;
  free_us: number;
  top_frame: string;
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
}

export function getAllocationDetail(allocations: Allocation[], addr: number): AllocationDetail | null {
  const a = allocations.find((a) => a.addr === addr);
  if (!a) return null;
  return {
    addr: a.addr,
    size: a.size,
    alloc_us: a.alloc_us,
    free_us: a.free_us,
    top_frame: a.top_frame,
    frames: a.frames,
  };
}

export type { Anomaly } from "./anomalies";
