// Pure parse: WASM JSON output → RankData. Runs inside Web Workers so the
// main thread never blocks on JSON.parse, treemap building, anomaly
// detection, or Float32 strip packing. No DOM / WebGL imports allowed here.
//
// Post-P0: WASM emits interned frame_pool + stack_pool and every reference
// (block top_frame, alloc top_frame, stack trace) is a u32 index. Parsing
// is now an index-plumbing exercise — no frame strings duplicated per
// allocation.

import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation, FrameRecord } from "../types/snapshot";
import type { TimelineBlock } from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";
import type { Anomaly } from "./anomalies";
import { detectAnomalies } from "./anomalies";
import type { Allocation, RankData } from "./index";
import { STRIP_PALETTE_RGB } from "./palette";

export interface ParseResult {
  data: RankData;
}

function formatTopFrame(idx: number, framePool: FrameRecord[]): string {
  if (idx < 0 || idx >= framePool.length) return "";
  const f = framePool[idx];
  // Match the old Rust top_frame formatter: "name @ basename:line" for .py,
  // else just a trimmed name. Used only for UI display / treemap labels.
  const name = f.name.split("(")[0].split("<")[0].trim();
  if (f.filename.includes(".py")) {
    const slash = f.filename.lastIndexOf("/");
    const short = slash >= 0 ? f.filename.slice(slash + 1) : f.filename;
    return `${name} @ ${short}:${f.line}`;
  }
  return name.length > 60 ? name.slice(0, 57) + "..." : name;
}

export function parseRank(json: string, _rank: number): ParseResult {
  const raw = JSON.parse(json);
  const summary: RankSummary = raw.summary;

  // ---- Frame / stack pools ----
  const rawFramePool: [string, string, number][] = raw.frame_pool || [];
  const framePool: FrameRecord[] = rawFramePool.map(([name, filename, line]) => ({
    name,
    filename,
    line,
  }));
  const rawStackPool: number[][] = raw.stack_pool || [];
  const stackPool: Uint32Array[] = rawStackPool.map((arr) => Uint32Array.from(arr));

  // ---- Allocations (worker-local, used only for anomaly detection below) ----
  const allocations: Allocation[] = (raw.alloc_details || []).map((a: any) => ({
    addr: a.addr,
    size: a.size,
    alloc_us: a.alloc_us,
    free_requested_us: a.free_requested_us,
    free_us: a.free_us,
    top_frame_idx: a.top_frame_idx,
    stack_idx: a.stack_idx,
  }));
  const anomalies: Anomaly[] = detectAnomalies(allocations, raw.timeline.time_max);

  // stackByAddr index so the main thread can resolve a detail panel's
  // stack without another worker round-trip. Small: top 3000 addrs × ~24B.
  const stackByAddr = new Map<
    number,
    { stack_idx: number; size: number; alloc_us: number; free_us: number; top_frame_idx: number }
  >();
  for (const a of allocations) {
    stackByAddr.set(a.addr, {
      stack_idx: a.stack_idx,
      size: a.size,
      alloc_us: a.alloc_us,
      free_us: a.free_us,
      top_frame_idx: a.top_frame_idx,
    });
  }

  // ---- Segments (treemap / address map / top allocations) ----
  const segments: SegmentInfo[] = (raw.segments || []).map((s: any) => ({
    address: s.address,
    total_size: s.total_size,
    allocated_size: s.allocated_size,
    segment_type: s.segment_type,
    blocks: (s.blocks || []).map((b: any) => ({
      address: b.address,
      size: b.size,
      state: b.state,
      offset_in_segment: b.offset_in_segment,
      top_frame_idx: b.top_frame_idx,
    })),
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
          name: b.top_frame_idx >= 0 ? formatTopFrame(b.top_frame_idx, framePool) : `0x${b.address.toString(16)}`,
          size: b.size,
          address: b.address,
          state: b.state,
          top_frame_idx: b.top_frame_idx,
        });
        topAllocations.push({
          address: b.address,
          size: b.size,
          source_idx: b.top_frame_idx,
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

  // Pre-pack strip buffer for WebGL (time normalized vs data.time_min).
  const rawBlocks = raw.blocks as {
    addr: number;
    size: number;
    alloc_us: number;
    free_requested_us: number;
    free_us: number;
    alive: boolean;
    top_frame_idx: number;
    idx: number;
    strips: { t_start: number; t_end: number; y_offset: number }[];
  }[];
  const timeOrigin: number = raw.timeline.time_min;
  let stripCount = 0;
  let maxBytesFull = 0;
  for (const b of rawBlocks) {
    stripCount += b.strips.length;
    for (const s of b.strips) {
      const t = s.y_offset + b.size;
      if (t > maxBytesFull) maxBytesFull = t;
    }
  }
  const stripBuffer = new Float32Array(stripCount * STRIP_FLOATS);
  const timelineBlocks: TimelineBlock[] = new Array(rawBlocks.length);
  let stripIdx = 0;
  for (let bi = 0; bi < rawBlocks.length; bi++) {
    const block = rawBlocks[bi];
    const [r, g, bl] = STRIP_PALETTE_RGB[block.idx % STRIP_PALETTE_RGB.length];
    const sz = block.size;
    const startStripIdx = stripIdx;
    for (const strip of block.strips) {
      const off = stripIdx * STRIP_FLOATS;
      stripBuffer[off] = strip.t_start - timeOrigin;
      stripBuffer[off + 1] = strip.t_end - timeOrigin;
      stripBuffer[off + 2] = strip.y_offset;
      stripBuffer[off + 3] = sz;
      stripBuffer[off + 4] = r;
      stripBuffer[off + 5] = g;
      stripBuffer[off + 6] = bl;
      stripIdx++;
    }
    timelineBlocks[bi] = {
      addr: block.addr,
      size: block.size,
      alloc_us: block.alloc_us,
      free_requested_us: block.free_requested_us,
      free_us: block.free_us,
      alive: block.alive,
      top_frame_idx: block.top_frame_idx,
      idx: block.idx,
      stripOffset: startStripIdx,
      stripCount: block.strips.length,
    };
  }

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
    timelineBlocks,
    anomalies,
    stripBuffer,
    stripCount,
    maxBytesFull: (maxBytesFull || raw.timeline.peak_bytes) * 1.1,
    framePool,
    stackPool,
    stackByAddr,
  };
  return { data };
}
