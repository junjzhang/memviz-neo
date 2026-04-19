export interface RankSummary {
  rank: number;
  total_reserved: number;
  total_allocated: number;
  total_active: number;
  segment_count: number;
  block_count: number;
  active_bytes: number;
  inactive_bytes: number;
  /** Bytes alive before the snapshot's event window began — these are
   *  real allocations we can't attribute to any in-window call stack.
   *  Already included in active_bytes / total_allocated. */
  baseline?: number;
  /** Peak GPU memory during the snapshot window (baseline + max net
   *  running allocations). This is the OOM-relevant "worst moment"
   *  number; active_bytes only reflects end-of-window state. */
  peak_bytes?: number;
  /** Raw PYTORCH_CUDA_ALLOC_CONF env var string, e.g.
   *  "expandable_segments:True". Empty if the snapshot didn't record it. */
  alloc_conf?: string;
  expandable_segments?: boolean;
  /** -1 means no split size cap. */
  max_split_size?: number;
  /** 0..1, 0 means disabled. */
  gc_threshold?: number;
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
