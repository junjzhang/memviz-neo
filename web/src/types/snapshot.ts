export interface RankSummary {
  rank: number;
  total_reserved: number;
  total_allocated: number;
  total_active: number;
  segment_count: number;
  block_count: number;
  active_bytes: number;
  inactive_bytes: number;
}

export interface TreemapNode {
  name: string;
  size: number;
  children?: TreemapNode[];
  address?: number;
  state?: string;
  /** Index into RankData.framePool; -1 if unknown. */
  top_frame_idx?: number;
}

export interface BlockInfo {
  address: number;
  size: number;
  state: string;
  offset_in_segment: number;
  /** Index into RankData.framePool; -1 if unknown. */
  top_frame_idx?: number;
}

export interface SegmentInfo {
  address: number;
  total_size: number;
  allocated_size: number;
  segment_type: string;
  blocks: BlockInfo[];
}

export interface TopAllocation {
  address: number;
  size: number;
  /** Index into RankData.framePool; -1 if unknown. */
  source_idx: number;
  segment_type: string;
}

/** One frame record. framePool is a shared array; everything else refers by index. */
export interface FrameRecord {
  name: string;
  filename: string;
  line: number;
}
