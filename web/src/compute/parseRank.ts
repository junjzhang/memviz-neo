// Pure parse: WASM JSON output → RankData. Runs inside Web Workers so the
// main thread never blocks on JSON.parse, treemap building, anomaly
// detection, or Float32 strip packing. No DOM / WebGL imports allowed here.

import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation } from "../types/snapshot";
import type { Anomaly } from "./anomalies";
import { detectAnomalies } from "./anomalies";
import type { Allocation, RankData, AllocationLite } from "./index";
import { STRIP_PALETTE_RGB } from "./palette";

export interface ParseResult {
  data: RankData;
  /**
   * Full allocation records (addr/size/time/top_frame/frames) kept
   * worker-local. Never crosses the message boundary at load time —
   * every structured-clone byte of this would be main-thread jank.
   * Fetched lazily via pool.getDetail(rank, addr).
   */
  detailsByAddr: Map<number, {
    addr: number;
    size: number;
    alloc_us: number;
    free_us: number;
    top_frame: string;
    frames: { name: string; filename: string; line: number }[];
  }>;
}

export function parseRank(json: string, _rank: number): ParseResult {
  const raw = JSON.parse(json);
  const summary: RankSummary = raw.summary;

  const detailsByAddr = new Map<number, any>();
  // Full allocations go to detectAnomalies only; nothing survives the
  // function except small derived structures.
  const allocations: Allocation[] = (raw.alloc_details || []).map((a: any) => {
    detailsByAddr.set(a.addr, {
      addr: a.addr,
      size: a.size,
      alloc_us: a.alloc_us,
      free_us: a.free_us,
      top_frame: a.top_frame,
      frames: a.frames || [],
    });
    return {
      addr: a.addr,
      size: a.size,
      alloc_us: a.alloc_us,
      free_requested_us: a.free_requested_us,
      free_us: a.free_us,
      top_frame: a.top_frame,
    } satisfies AllocationLite as any;
  });
  // detectAnomalies uses addr/size/time/top_frame; it doesn't need frames.
  const anomalies: Anomaly[] = detectAnomalies(allocations, raw.timeline.time_max);

  const segments: SegmentInfo[] = (raw.segments || []).map((s: any) => ({
    address: s.address,
    total_size: s.total_size,
    allocated_size: s.allocated_size,
    segment_type: s.segment_type,
    blocks: s.blocks || [],
  }));
  segments.sort((a, b) => b.total_size - a.total_size);

  const topAllocations: TopAllocation[] = [];
  const treemapTypeMap = new Map<string, TreemapNode[]>();
  for (const seg of raw.segments || []) {
    const segChildren: TreemapNode[] = [];
    let smallTotal = 0;
    for (const b of seg.blocks || []) {
      if (b.state !== "active_allocated") continue;
      if (b.size >= 1048576) {
        segChildren.push({
          name: b.top_frame || `0x${b.address.toString(16)}`,
          size: b.size,
          address: b.address,
          state: b.state,
          top_frame: b.top_frame,
        });
        topAllocations.push({
          address: b.address,
          size: b.size,
          source: b.top_frame,
          segment_type: seg.segment_type,
        });
      } else {
        smallTotal += b.size;
      }
    }
    if (smallTotal > 0) segChildren.push({ name: "(small blocks)", size: smallTotal });
    if (segChildren.length === 0) continue;
    segChildren.sort((a, b) => b.size - a.size);
    const segNode: TreemapNode = {
      name: `seg 0x${seg.address.toString(16)}`,
      size: segChildren.reduce((s, c) => s + c.size, 0),
      address: seg.address,
      children: segChildren,
    };
    const bucket = treemapTypeMap.get(seg.segment_type) ?? [];
    bucket.push(segNode);
    treemapTypeMap.set(seg.segment_type, bucket);
  }
  const rootChildren: TreemapNode[] = [];
  for (const [segType, segs] of [...treemapTypeMap.entries()].sort()) {
    segs.sort((a, b) => b.size - a.size);
    rootChildren.push({
      name: segType,
      size: segs.reduce((s, c) => s + c.size, 0),
      children: segs,
    });
  }
  rootChildren.sort((a, b) => b.size - a.size);
  const treemap: TreemapNode = {
    name: "GPU Memory",
    size: rootChildren.reduce((s, c) => s + c.size, 0),
    children: rootChildren,
  };
  topAllocations.sort((a, b) => b.size - a.size);

  // Pre-pack strip buffer for WebGL. Subtract time_min first: real PyTorch
  // traces use absolute Unix timestamps (~1.77e15), which collapse to
  // zero-width quads when stored as Float32 without normalization.
  const blocks = raw.blocks as {
    strips: { t_start: number; t_end: number; y_offset: number }[];
    size: number;
    idx: number;
  }[];
  const timeOrigin: number = raw.timeline.time_min;
  let stripCount = 0;
  let maxBytesFull = 0;
  for (const b of blocks) {
    stripCount += b.strips.length;
    for (const s of b.strips) {
      const t = s.y_offset + b.size;
      if (t > maxBytesFull) maxBytesFull = t;
    }
  }
  const stripBuffer = new Float32Array(stripCount * 7);
  let off = 0;
  for (const block of blocks) {
    const [r, g, bl] = STRIP_PALETTE_RGB[block.idx % STRIP_PALETTE_RGB.length];
    const sz = block.size;
    for (const strip of block.strips) {
      stripBuffer[off++] = strip.t_start - timeOrigin;
      stripBuffer[off++] = strip.t_end - timeOrigin;
      stripBuffer[off++] = strip.y_offset;
      stripBuffer[off++] = sz;
      stripBuffer[off++] = r;
      stripBuffer[off++] = g;
      stripBuffer[off++] = bl;
    }
  }

  // Discard the big `allocations` array before returning — detectAnomalies
  // consumed it and we don't want to clone it across the worker boundary.
  void allocations;

  const data: RankData = {
    summary,
    treemap,
    segments,
    topAllocations: topAllocations.slice(0, 100),
    timeline: {
      usage_series: [],
      annotations: [],
      time_min: raw.timeline.time_min,
      time_max: raw.timeline.time_max,
      peak_bytes: raw.timeline.peak_bytes,
      allocation_count: raw.timeline.allocation_count,
    },
    timelineBlocks: raw.blocks,
    anomalies,
    stripBuffer,
    stripCount,
    maxBytesFull: (maxBytesFull || raw.timeline.peak_bytes) * 1.1,
  };
  return { data, detailsByAddr };
}
