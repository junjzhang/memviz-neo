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

/**
 * TimelineBlock no longer carries a strips: Strip[] array — that plain-
 * object array was the dominant structured-clone cost during load. The
 * strip data lives entirely in the pre-packed stripBuffer (7 floats per
 * strip). Use `stripOffset` (strip index, not float offset) and
 * `stripCount` to slice into it.
 *
 * Layout: stripBuffer[(stripOffset + i) * STRIP_FLOATS + field]
 * fields: 0 t_start_norm, 1 t_end_norm, 2 y_offset, 3 size,
 *         4 r, 5 g, 6 b
 */
export interface TimelineBlock {
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number; // -1 if no free_requested event
  free_us: number;
  alive: boolean;
  top_frame: string;
  idx: number;
  stripOffset: number;
  stripCount: number;
}

export const STRIP_FLOATS = 7;

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
