// Layout-worker entry: takes the Rust-emitted IR JSON (frames/stack
// pools, segments, top-N allocations) and produces the final RankData
// the main thread renders. Polygon layout runs here in pure JS so the
// N layout workers never touch WASM — their JS heap is GC'd, unlike
// WASM linear memory which is grow-only.
//
// parseRank is intentionally a thin pipeline: each stage below is a
// named helper that consumes the previous stage's output. Read from
// top to bottom.

import type { RankSummary, SegmentInfo, TopAllocation, FrameRecord } from "../types/snapshot";
import type { TimelineAlloc } from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";
import type { Anomaly } from "./anomalies";
import { detectAnomalies } from "./anomalies";
import type { Allocation, RankData, SegmentRow, SegmentAlloc, FlameData, FlameNode } from "./index";
import { blockColor } from "./palette";
import { eventIdxAt } from "./eventTimes";
import { isInternalFrame } from "../utils";

export interface ParseResult {
  data: RankData;
}

interface TopAllocIR {
  idx: number;
  addr: number;
  size: number;
  alloc_us: number;
  free_requested_us: number;
  free_us: number; // -1 if alive
  top_frame_idx: number;
  stack_idx: number;
}

/** Output of `packStrips` — downstream stages (segment rows, RankData
 *  assembly) consume these aggregates together so we pass one struct. */
interface PackedTimeline {
  stripBuffer: Float32Array;        // GPU buffer, time axis (μs since t_min)
  stripBufferEvent: Float32Array;   // GPU buffer, event-ordinal axis
  eventTimes: Float64Array;         // sorted unique event times (relative to t_min)
  timelineAllocs: TimelineAlloc[];  // one per alloc; stripOffset/Count point into stripBuffer
  /** [r, g, b] per alloc, flat. Segment rows reuse this so colors match. */
  allocColors: Float32Array;
  maxBytesFull: number;             // largest y + size seen across all strips
  stripCount: number;
}

// Port of the Rust build_layout (removed from WASM). O(N²) over top-N.
// Output: flat array of [li, t_start, t_end, y_offset] quadruples.
function buildLayout(allocs: TopAllocIR[], tMax: number): Float64Array {
  const n = allocs.length;
  if (n === 0) return new Float64Array(0);

  // Event list: (time, et, li, size). et=1 alloc, et=0 free.
  const evCap = n * 2;
  const evTime = new Float64Array(evCap);
  const evEt = new Uint8Array(evCap);
  const evLi = new Int32Array(evCap);
  const evSz = new Float64Array(evCap);
  let evN = 0;
  for (let li = 0; li < n; li++) {
    const a = allocs[li];
    evTime[evN] = a.alloc_us; evEt[evN] = 1; evLi[evN] = li; evSz[evN] = a.size; evN++;
    if (a.free_us !== -1) {
      evTime[evN] = a.free_us; evEt[evN] = 0; evLi[evN] = li; evSz[evN] = a.size; evN++;
    }
  }
  // Sort by time asc, then et asc so frees at equal time come first
  // (matches Rust's tuple-sort of (time, et, ...) where free=0, alloc=1).
  const orderArr: number[] = new Array(evN);
  for (let i = 0; i < evN; i++) orderArr[i] = i;
  orderArr.sort((a, b) => {
    const d = evTime[a] - evTime[b];
    if (d !== 0) return d;
    return evEt[a] - evEt[b];
  });

  // Stack of live ids + sizes, parallel arrays. pos[li] = index into stack or -1.
  const skId: number[] = new Array(n);
  const skSz: number[] = new Array(n);
  let skLen = 0;
  const pos = new Int32Array(n).fill(-1);
  const tSt = new Float64Array(n);
  const y = new Float64Array(n);
  const act = new Uint8Array(n);
  let stot = 0;

  // Output grows; size unknown upfront. Use plain array and flatten.
  const outLi: number[] = [];
  const outTs: number[] = [];
  const outTe: number[] = [];
  const outYo: number[] = [];

  for (let k = 0; k < evN; k++) {
    const i = orderArr[k];
    const time = evTime[i];
    const et = evEt[i];
    const li = evLi[i];
    const sz = evSz[i];
    if (et === 1) {
      y[li] = stot;
      tSt[li] = time;
      pos[li] = skLen;
      skId[skLen] = li;
      skSz[skLen] = sz;
      skLen++;
      act[li] = 1;
      stot += sz;
    } else {
      const p = pos[li];
      if (p === -1) continue;
      if (tSt[li] < time) {
        outLi.push(li); outTs.push(tSt[li]); outTe.push(time); outYo.push(y[li]);
      }
      act[li] = 0;
      pos[li] = -1;
      const freed = skSz[p];
      for (let j = p; j < skLen - 1; j++) {
        skId[j] = skId[j + 1];
        skSz[j] = skSz[j + 1];
      }
      skLen--;
      stot -= freed;
      // Update positions + emit closing strips + shift y down by freed.
      for (let j = p; j < skLen; j++) {
        const ai = skId[j];
        pos[ai] = j;
        const oy = y[ai];
        if (tSt[ai] < time) {
          outLi.push(ai); outTs.push(tSt[ai]); outTe.push(time); outYo.push(oy);
        }
        tSt[ai] = time;
        y[ai] = oy - freed;
      }
    }
  }
  // Close any still-live strips to t_max.
  for (let li = 0; li < n; li++) {
    if (act[li] && tSt[li] < tMax) {
      outLi.push(li); outTs.push(tSt[li]); outTe.push(tMax); outYo.push(y[li]);
    }
  }
  const m = outLi.length;
  const flat = new Float64Array(m * 4);
  for (let i = 0; i < m; i++) {
    flat[i * 4] = outLi[i];
    flat[i * 4 + 1] = outTs[i];
    flat[i * 4 + 2] = outTe[i];
    flat[i * 4 + 3] = outYo[i];
  }
  return flat;
}

/**
 * Turn the layout output into GPU-ready strip buffers + per-alloc
 * TimelineAllocs. Colors are assigned here (stable per-call-site hue +
 * per-instance lightness shift) so segment rows can re-use them for
 * cross-view color consistency.
 *
 * Also synthesises the "event ordinal" buffer for the alternate X-axis
 * mode: same geometry, t columns replaced by event indices.
 */
function packStrips(
  topAllocsIR: TopAllocIR[],
  stripsFlat: Float64Array,
  baseline: number,
  timeMin: number,
  timeMax: number,
): PackedTimeline {
  const n = topAllocsIR.length;
  const totalStrips = stripsFlat.length / 4;

  // Bucket strips by owning alloc so we can emit contiguous per-block
  // ranges in the Float32 buffer.
  const stripsPerAlloc: number[][] = new Array(n);
  for (let i = 0; i < n; i++) stripsPerAlloc[i] = [];
  for (let s = 0; s < totalStrips; s++) {
    stripsPerAlloc[stripsFlat[s * 4] as number].push(s);
  }

  // Sorted unique event timestamps (relative to timeMin). Each alloc
  // / free marks one event; live-at-end strips close at timeMax. Powers
  // the "event" X-axis mode by compressing idle gaps.
  const eventSet = new Set<number>();
  eventSet.add(0);
  eventSet.add(timeMax - timeMin);
  for (const a of topAllocsIR) {
    eventSet.add(a.alloc_us - timeMin);
    if (a.free_us >= 0) eventSet.add(a.free_us - timeMin);
  }
  const eventTimes = Float64Array.from([...eventSet].sort((a, b) => a - b));

  const stripBuffer = new Float32Array(totalStrips * STRIP_FLOATS);
  const timelineAllocs: TimelineAlloc[] = new Array(n);
  const allocColors = new Float32Array(n * 3);
  // maxBytes starts at baseline since in-window strips get shifted up
  // by that much (the Y axis reflects absolute GPU bytes).
  let maxBytesFull = baseline;
  // Per-hueKey instance counter so repeated allocs from the same call
  // site get lightness-shifted shades inside the same color family.
  const instanceCount = new Map<number, number>();
  let writeIdx = 0;

  for (let i = 0; i < n; i++) {
    const a = topAllocsIR[i];
    // Prefer top_frame_idx for hue (user-code line); fall back to
    // stack_idx when the allocator stack has no .py frame so
    // un-attributed allocs still fan out rather than all turning gray.
    const hueKey = a.top_frame_idx >= 0 ? a.top_frame_idx : 0x100000 + a.stack_idx;
    const inst = instanceCount.get(hueKey) || 0;
    instanceCount.set(hueKey, inst + 1);
    const [r, g, bl] = blockColor(hueKey, inst);
    allocColors[i * 3] = r;
    allocColors[i * 3 + 1] = g;
    allocColors[i * 3 + 2] = bl;
    const sz = a.size;
    const startStripIdx = writeIdx;
    for (const s of stripsPerAlloc[i]) {
      const tStart = stripsFlat[s * 4 + 1];
      const tEnd = stripsFlat[s * 4 + 2];
      const yOff = stripsFlat[s * 4 + 3];
      const off = writeIdx * STRIP_FLOATS;
      stripBuffer[off] = tStart - timeMin;
      stripBuffer[off + 1] = tEnd - timeMin;
      stripBuffer[off + 2] = yOff + baseline;
      stripBuffer[off + 3] = sz;
      stripBuffer[off + 4] = r;
      stripBuffer[off + 5] = g;
      stripBuffer[off + 6] = bl;
      const top = yOff + baseline + sz;
      if (top > maxBytesFull) maxBytesFull = top;
      writeIdx++;
    }
    const alive = a.free_us === -1;
    const freeUs = alive ? timeMax : a.free_us;
    timelineAllocs[i] = {
      addr: a.addr,
      size: a.size,
      alloc_us: a.alloc_us,
      free_requested_us: a.free_requested_us,
      free_us: freeUs,
      alive,
      top_frame_idx: a.top_frame_idx,
      idx: i,
      stripOffset: startStripIdx,
      stripCount: stripsPerAlloc[i].length,
    };
  }

  // Event-axis buffer: same geometry as stripBuffer but with t_start /
  // t_end remapped to eventTimes indices. One pass, O(strips × log(events)).
  const stripBufferEvent = new Float32Array(stripBuffer.length);
  for (let s = 0; s < totalStrips; s++) {
    const off = s * STRIP_FLOATS;
    stripBufferEvent[off]     = eventIdxAt(eventTimes, stripBuffer[off]);
    stripBufferEvent[off + 1] = eventIdxAt(eventTimes, stripBuffer[off + 1]);
    stripBufferEvent[off + 2] = stripBuffer[off + 2];
    stripBufferEvent[off + 3] = stripBuffer[off + 3];
    stripBufferEvent[off + 4] = stripBuffer[off + 4];
    stripBufferEvent[off + 5] = stripBuffer[off + 5];
    stripBufferEvent[off + 6] = stripBuffer[off + 6];
  }

  return {
    stripBuffer,
    stripBufferEvent,
    eventTimes,
    timelineAllocs,
    allocColors,
    maxBytesFull,
    stripCount: totalStrips,
  };
}

/**
 * Bucket every top-N alloc into the segment whose [address, address+size)
 * range contains it. Empty segments still appear as rows so the
 * allocator layout stays visible even before allocs arrive.
 */
function buildSegmentRows(
  segments: SegmentInfo[],
  topAllocsIR: TopAllocIR[],
  timelineAllocs: TimelineAlloc[],
  allocColors: Float32Array,
): SegmentRow[] {
  const segsByAddr = segments.slice().sort((a, b) => a.address - b.address);
  const rows = new Map<number, SegmentRow>();
  for (const seg of segsByAddr) {
    rows.set(seg.address, {
      segmentAddr: seg.address,
      segmentType: seg.segment_type,
      totalSize: seg.total_size,
      allocs: [],
    });
  }
  function findSegmentIdx(addr: number): number {
    let lo = 0, hi = segsByAddr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segsByAddr[mid];
      if (addr < seg.address) hi = mid - 1;
      else if (addr >= seg.address + seg.total_size) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  for (let i = 0; i < topAllocsIR.length; i++) {
    const a = topAllocsIR[i];
    const segIdx = findSegmentIdx(a.addr);
    if (segIdx < 0) continue;
    const seg = segsByAddr[segIdx];
    const sa: SegmentAlloc = {
      addr: a.addr,
      offsetInSeg: a.addr - seg.address,
      size: a.size,
      alloc_us: a.alloc_us,
      free_us: timelineAllocs[i].free_us,
      top_frame_idx: a.top_frame_idx,
      color: [allocColors[i * 3], allocColors[i * 3 + 1], allocColors[i * 3 + 2]],
    };
    rows.get(seg.address)!.allocs.push(sa);
  }

  // Biggest cached segments first — matches the Memory Timeline's
  // convention of putting the largest, most-significant data at the top.
  return [...rows.values()].sort((a, b) => b.totalSize - a.totalSize);
}

/**
 * Build a prefix trie of call stacks weighted by size × lifetime
 * (bytes·μs of memory pressure), then DFS-flatten into a flat node list
 * the flame-graph view can draw directly. Allocator-internal + C++
 * frames get filtered out so the tree shows human-readable PyTorch
 * code paths.
 */
function buildFlameGraph(
  topAllocsIR: TopAllocIR[],
  stackPool: Uint32Array[],
  framePool: FrameRecord[],
  timeMax: number,
): FlameData {
  interface Trie { frameIdx: number; weight: number; kids: Map<number, Trie>; }
  const root: Trie = { frameIdx: -1, weight: 0, kids: new Map() };

  for (const a of topAllocsIR) {
    const lifetime = a.free_us === -1 ? (timeMax - a.alloc_us) : (a.free_us - a.alloc_us);
    if (lifetime <= 0) continue;
    const weight = a.size * lifetime;
    const stack = stackPool[a.stack_idx];
    if (!stack) continue;
    // PyTorch records frames leaf-first; flip to root-first so the
    // flame graph reads naturally (top-level caller at the bottom).
    root.weight += weight;
    let cursor = root;
    for (let k = stack.length - 1; k >= 0; k--) {
      const fi = stack[k];
      const f = framePool[fi];
      if (!f || isInternalFrame(f)) continue;
      let child = cursor.kids.get(fi);
      if (!child) {
        child = { frameIdx: fi, weight: 0, kids: new Map() };
        cursor.kids.set(fi, child);
      }
      child.weight += weight;
      cursor = child;
    }
  }

  const nodes: FlameNode[] = [];
  let maxDepth = 0;
  (function dfs(node: Trie, depth: number, xStart: number) {
    nodes.push({ frameIdx: node.frameIdx, depth, weight: node.weight, xStart });
    if (depth > maxDepth) maxDepth = depth;
    const kids = [...node.kids.values()].sort((a, b) => b.weight - a.weight);
    let cursor = xStart;
    for (const kid of kids) {
      dfs(kid, depth + 1, cursor);
      cursor += kid.weight;
    }
  })(root, 0, 0);

  return { nodes, totalWeight: root.weight, maxDepth };
}

/**
 * Flatten every allocated-block-that's-≥1MiB from the segments into a
 * plain list for the Address Map + TopAllocations views. Sorted size desc.
 */
function extractTopAllocations(rawSegments: any[]): TopAllocation[] {
  const out: TopAllocation[] = [];
  for (const seg of rawSegments) {
    for (const b of seg.blocks || []) {
      if (b.state !== "active_allocated") continue;
      if (b.size < 1048576) continue;
      out.push({
        address: b.address,
        size: b.size,
        source_idx: b.top_frame_idx,
        segment_type: seg.segment_type,
      });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

export function parseRank(irJson: string, _rank: number): ParseResult {
  const raw = JSON.parse(irJson);
  const summary: RankSummary = raw.summary;

  // ---- Pools + raw inputs ----
  const rawFramePool: [string, string, number][] = raw.frame_pool || [];
  const framePool: FrameRecord[] = rawFramePool.map(([name, filename, line]) => ({ name, filename, line }));
  const rawStackPool: number[][] = raw.stack_pool || [];
  const stackPool: Uint32Array[] = rawStackPool.map((arr) => Uint32Array.from(arr));

  const topAllocsIR: TopAllocIR[] = raw.top_allocations || [];
  const timeMin: number = raw.timeline.time_min;
  const timeMax: number = raw.timeline.time_max;
  // Pre-window allocations not freed in window — aggregated, not
  // per-alloc. Drawn as an opaque band at the bottom so the y axis
  // reflects real memory usage instead of "delta from window start".
  const baseline: number = raw.timeline.baseline || 0;

  // ---- Segments ----
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
  const topAllocations = extractTopAllocations(raw.segments || []);

  // ---- Anomaly detection over the top-N (same cohort the UI surfaces) ----
  const allocations: Allocation[] = topAllocsIR.map((a) => ({
    addr: a.addr,
    size: a.size,
    alloc_us: a.alloc_us,
    free_requested_us: a.free_requested_us,
    free_us: a.free_us,
    top_frame_idx: a.top_frame_idx,
    stack_idx: a.stack_idx,
  }));
  const anomalies: Anomaly[] = detectAnomalies(allocations, timeMax);

  // Detail lookup: keyed by "addr-alloc_us" so address reuse (PyTorch
  // re-allocates freed GPU memory) doesn't collide.
  const stackByIdentity = new Map<
    string,
    { stack_idx: number; size: number; alloc_us: number; free_us: number; top_frame_idx: number }
  >();
  for (const a of allocations) {
    stackByIdentity.set(`${a.addr}-${a.alloc_us}`, {
      stack_idx: a.stack_idx,
      size: a.size,
      alloc_us: a.alloc_us,
      free_us: a.free_us,
      top_frame_idx: a.top_frame_idx,
    });
  }

  // ---- Layout → strip packing → segment rows → flame graph ----
  const stripsFlat = buildLayout(topAllocsIR, timeMax);
  const packed = packStrips(topAllocsIR, stripsFlat, baseline, timeMin, timeMax);
  const segmentRows = buildSegmentRows(segments, topAllocsIR, packed.timelineAllocs, packed.allocColors);
  const flame = buildFlameGraph(topAllocsIR, stackPool, framePool, timeMax);

  const data: RankData = {
    summary,
    segments,
    topAllocations: topAllocations.slice(0, 100),
    timeline: {
      usage_series: [],
      annotations: [],
      time_min: timeMin,
      time_max: timeMax,
      peak_bytes: raw.timeline.peak_bytes,
      allocation_count: raw.timeline.allocation_count,
      baseline,
    },
    timelineAllocs: packed.timelineAllocs,
    anomalies,
    stripBuffer: packed.stripBuffer,
    stripBufferEvent: packed.stripBufferEvent,
    eventTimes: packed.eventTimes,
    stripCount: packed.stripCount,
    maxBytesFull: (packed.maxBytesFull || raw.timeline.peak_bytes) * 1.1,
    segmentRows,
    flame,
    framePool,
    stackPool,
    stackByIdentity,
  };
  return { data };
}
