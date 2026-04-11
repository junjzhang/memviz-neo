export interface TimelineData {
  usage_series: [number, number][]; // [time_us, total_bytes]
  annotations: TimelineAnnotation[];
  time_min: number;
  time_max: number;
  peak_bytes: number;
  allocation_count: number;
}

export interface TimelineAnnotation {
  stage: "START" | "END";
  name: string;
  time_us: number;
}

export interface Strip {
  t_start: number;
  t_end: number;
  y_offset: number;
}

export interface TimelineBlock {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number; // -1 if no free_requested event
  free_us: number;
  alive: boolean;
  top_frame: string;
  idx: number;
  strips: Strip[];
}

export interface TimelineBlocksResponse {
  blocks: TimelineBlock[];
}

export interface AllocationDetail {
  addr: number;
  size: number;
  alloc_us: number;
  free_us: number;
  top_frame: string;
  frames: { name: string; filename: string; line: number }[];
}
