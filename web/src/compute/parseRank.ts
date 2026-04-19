// Layout-worker entry: takes the Rust-emitted IR JSON (frames/stack
// pools, segments, top-N allocations) and produces the final RankData
// the main thread renders. Polygon layout runs here in pure JS so the
// N layout workers never touch WASM — their JS heap is GC'd, unlike
// WASM linear memory which is grow-only.

import type { RankSummary, TreemapNode, SegmentInfo, TopAllocation, FrameRecord } from "../types/snapshot";
import type { TimelineBlock } from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";
import type { Anomaly } from "./anomalies";
import { detectAnomalies } from "./anomalies";
import type { Allocation, RankData, SegmentRow, SegmentAlloc } from "./index";
import { blockColor } from "./palette";

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

function formatTopFrame(idx: number, framePool: FrameRecord[]): string {
  if (idx < 0 || idx >= framePool.length) return "";
  const f = framePool[idx];
  const name = f.name.split("(")[0].split("<")[0].trim();
  if (f.filename.includes(".py")) {
    const slash = f.filename.lastIndexOf("/");
    const short = slash >= 0 ? f.filename.slice(slash + 1) : f.filename;
    return `${name} @ ${short}:${f.line}`;
  }
  return name.length > 60 ? name.slice(0, 57) + "..." : name;
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
  const order = new Int32Array(evN);
  for (let i = 0; i < evN; i++) order[i] = i;
  const orderArr = Array.from(order);
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
      // Shift down (array splice at p).
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

export function parseRank(irJson: string, _rank: number): ParseResult {
  const raw = JSON.parse(irJson);
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

  // ---- Top-N allocations (IR) ----
  const topAllocsIR: TopAllocIR[] = raw.top_allocations || [];
  const timeMin: number = raw.timeline.time_min;
  const timeMax: number = raw.timeline.time_max;
  // Pre-window allocations not freed in window — aggregated, not
  // per-allocation. Drawn as an opaque band at the bottom so the y axis
  // reflects real memory usage instead of "delta from window start".
  const baseline: number = raw.timeline.baseline || 0;

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

  // stackByAddr index for sync main-thread detail resolution.
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

  // ---- Segments (treemap / address map / top allocations for UI) ----
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

  // ---- Polygon layout + strip packing ----
  const stripsFlat = buildLayout(topAllocsIR, timeMax);
  const totalStrips = stripsFlat.length / 4;

  // Bucket strips by allocation index so we can compute contiguous
  // [offset, count] ranges per block when packing the Float32 buffer.
  const stripsPerAlloc: number[][] = new Array(topAllocsIR.length);
  for (let i = 0; i < topAllocsIR.length; i++) stripsPerAlloc[i] = [];
  for (let s = 0; s < totalStrips; s++) {
    const li = stripsFlat[s * 4] as number;
    stripsPerAlloc[li].push(s);
  }

  const stripBuffer = new Float32Array(totalStrips * STRIP_FLOATS);
  const timelineBlocks: TimelineBlock[] = new Array(topAllocsIR.length);
  // Polygon layout produces y offsets relative to "zero active memory";
  // we shift them up by `baseline` (pre-window allocations still alive)
  // so the final y axis maps to absolute GPU memory bytes. maxBytesFull
  // therefore starts at `baseline` and grows as strips pile on top.
  let maxBytesFull = baseline;

  // Event axis: collect sorted unique event timestamps (relative to
  // timeMin). Each alloc / free marks one event. The live-at-end edge
  // also lands at timeMax. This is what the "event" X-axis mode uses
  // to compress idle gaps and stretch allocation-dense phases.
  const eventSet = new Set<number>();
  eventSet.add(0);                    // tMin edge
  eventSet.add(timeMax - timeMin);    // tMax edge (alive strips close here)
  for (const a of topAllocsIR) {
    eventSet.add(a.alloc_us - timeMin);
    if (a.free_us >= 0) eventSet.add(a.free_us - timeMin);
  }
  const eventTimes = Float64Array.from([...eventSet].sort((a, b) => a - b));
  function eventIdxAt(tNorm: number): number {
    let lo = 0, hi = eventTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (eventTimes[mid] < tNorm) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  let writeIdx = 0;
  // Per-hueKey instance counter so repeated allocs from the same call
  // site get lightness-shifted shades in the same color family.
  const instanceCount = new Map<number, number>();

  // ---- Segment rows (SegmentTimeline view) ----
  // Bucket allocs by the segment they land in. Build a sorted-by-addr
  // index so each alloc's lookup is O(log N_seg). Segments without any
  // top-N allocations still show up as empty rows so the allocator
  // layout stays visible.
  const segsByAddr = segments.slice().sort((a, b) => a.address - b.address);
  const segRowByAddr = new Map<number, SegmentRow>();
  for (const seg of segsByAddr) {
    segRowByAddr.set(seg.address, {
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
    // Prefer top_frame_idx for hue (user-code line); fall back to
    // stack_idx when the allocator stack has no .py frame so
    // un-attributed blocks still fan out rather than all turning gray.
    const hueKey = a.top_frame_idx >= 0 ? a.top_frame_idx : 0x100000 + a.stack_idx;
    const inst = instanceCount.get(hueKey) || 0;
    instanceCount.set(hueKey, inst + 1);
    const [r, g, bl] = blockColor(hueKey, inst);
    const sz = a.size;
    const startStripIdx = writeIdx;
    for (const s of stripsPerAlloc[i]) {
      const tStart = stripsFlat[s * 4 + 1];
      const tEnd = stripsFlat[s * 4 + 2];
      const yOff = stripsFlat[s * 4 + 3];
      const off = writeIdx * STRIP_FLOATS;
      stripBuffer[off] = tStart - timeMin;
      stripBuffer[off + 1] = tEnd - timeMin;
      // Shift all in-window strips up by the pre-window baseline so the
      // Y axis reflects absolute memory bytes. The [0..baseline] band
      // at the bottom represents long-lived pre-window allocations that
      // never freed inside the snapshot window — drawn as a grey
      // "baseline floor" in the renderer.
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
    timelineBlocks[i] = {
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

    // Assign this alloc to its owning segment row.
    const segIdx = findSegmentIdx(a.addr);
    if (segIdx >= 0) {
      const seg = segsByAddr[segIdx];
      const row = segRowByAddr.get(seg.address)!;
      const sa: SegmentAlloc = {
        addr: a.addr,
        offsetInSeg: a.addr - seg.address,
        size: a.size,
        alloc_us: a.alloc_us,
        free_us: freeUs,
        top_frame_idx: a.top_frame_idx,
        color: [r, g, bl],
      };
      row.allocs.push(sa);
    }
  }
  // Biggest cached segments first — matches the Memory Timeline's
  // convention of putting the largest, most-significant data at the top.
  const segmentRows: SegmentRow[] = [...segRowByAddr.values()]
    .sort((a, b) => b.totalSize - a.totalSize);

  // Build the event-axis strip buffer by mapping each t_start/t_end to
  // its position in the sorted event list. Y / color columns copy over
  // unchanged. One pass, O(strips × log(events)).
  const stripBufferEvent = new Float32Array(stripBuffer.length);
  for (let s = 0; s < totalStrips; s++) {
    const off = s * STRIP_FLOATS;
    stripBufferEvent[off]     = eventIdxAt(stripBuffer[off]);
    stripBufferEvent[off + 1] = eventIdxAt(stripBuffer[off + 1]);
    stripBufferEvent[off + 2] = stripBuffer[off + 2];
    stripBufferEvent[off + 3] = stripBuffer[off + 3];
    stripBufferEvent[off + 4] = stripBuffer[off + 4];
    stripBufferEvent[off + 5] = stripBuffer[off + 5];
    stripBufferEvent[off + 6] = stripBuffer[off + 6];
  }

  // ---- Flame graph aggregate (call-stack → memory pressure) ----
  // Build a prefix trie keyed by stack frame index, weighted by
  // size × lifetime (bytes·μs). Only user-relevant frames participate:
  // allocator-internal + C++ frames are stripped so the tree is
  // readable for humans inspecting PyTorch code paths.
  interface FlameTrie {
    frameIdx: number;
    weight: number;
    kids: Map<number, FlameTrie>;
  }
  const flameRoot: FlameTrie = { frameIdx: -1, weight: 0, kids: new Map() };
  function isInternalFrame(fi: number): boolean {
    const f = framePool[fi];
    if (!f) return true;
    if (f.filename === "??") return true;
    if (f.name.includes("CUDACachingAllocator")) return true;
    if (f.filename.includes("memory_snapshot")) return true;
    return false;
  }
  for (const a of topAllocsIR) {
    const lifetime = a.free_us === -1 ? (timeMax - a.alloc_us) : (a.free_us - a.alloc_us);
    if (lifetime <= 0) continue;
    const weight = a.size * lifetime;
    const stack = stackPool[a.stack_idx];
    if (!stack) continue;
    // PyTorch records frames leaf-first; flip to root-first so the
    // flame graph reads naturally (top-level caller at the bottom).
    flameRoot.weight += weight;
    let cursor = flameRoot;
    for (let k = stack.length - 1; k >= 0; k--) {
      const fi = stack[k];
      if (isInternalFrame(fi)) continue;
      let child = cursor.kids.get(fi);
      if (!child) {
        child = { frameIdx: fi, weight: 0, kids: new Map() };
        cursor.kids.set(fi, child);
      }
      child.weight += weight;
      cursor = child;
    }
  }
  // Flatten DFS into [{frameIdx, depth, weight, xStart}]. Children are
  // ordered by descending weight so the biggest contributors line up
  // on the left.
  const flameNodes: { frameIdx: number; depth: number; weight: number; xStart: number }[] = [];
  let flameMaxDepth = 0;
  (function dfs(node: FlameTrie, depth: number, xStart: number) {
    flameNodes.push({ frameIdx: node.frameIdx, depth, weight: node.weight, xStart });
    if (depth > flameMaxDepth) flameMaxDepth = depth;
    const kids = [...node.kids.values()].sort((a, b) => b.weight - a.weight);
    let cursor = xStart;
    for (const kid of kids) {
      dfs(kid, depth + 1, cursor);
      cursor += kid.weight;
    }
  })(flameRoot, 0, 0);

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
      baseline,
    },
    timelineBlocks,
    anomalies,
    stripBuffer,
    stripBufferEvent,
    eventTimes,
    stripCount: totalStrips,
    maxBytesFull: (maxBytesFull || raw.timeline.peak_bytes) * 1.1,
    segmentRows,
    flame: {
      nodes: flameNodes,
      totalWeight: flameRoot.weight,
      maxDepth: flameMaxDepth,
    },
    framePool,
    stackPool,
    stackByAddr,
  };
  return { data };
}
