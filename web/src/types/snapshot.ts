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
  top_frame?: string;
}

export interface BlockInfo {
  address: number;
  size: number;
  state: string;
  offset_in_segment: number;
  top_frame?: string;
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
  source: string | null;
  segment_type: string;
}
