import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type {
  TimelineData,
  TimelineAlloc,
  AllocationDetail,
} from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";
import { formatBytes, formatTopFrame } from "../utils";
import { useDataStore } from "../stores/dataStore";
import { initGL, uploadStrips, drawStrips, type GLState } from "./glRenderer";

import type { Anomaly } from "../compute";

interface Props {
  data: TimelineData;
  allocs: TimelineAlloc[];
  anomalies: Anomaly[];
  width: number;
  height: number;
  currentRank: number;
  /** Optional shared ref so sibling views (SegmentTimeline) pan in lockstep. */
  viewRangeRef?: React.MutableRefObject<[number, number]>;
}

const ANOMALY_COLORS: Record<string, string> = {
  pending_free: "#f87171",
  leak: "#fbbf24",
};
const FLAG_SIZE = 8;
// Cap flags drawn on the timeline to avoid visual overload.
// The panel still shows all anomalies. Sorted by severity, so we keep the worst.
const TIMELINE_FLAG_LIMIT = 40;

import {
  COLOR_BG,
  COLOR_GRID,
  COLOR_AXIS,
  COLOR_AXIS_DIM,
  COLOR_ACCENT,
  COLOR_PEAK,
  FONT_MONO,
  FONT_MONO_SM,
  FONT_DISPLAY_SM,
} from "./theme";

const MARGIN = { top: 24, right: 24, bottom: 44, left: 88 };


type RulerType = "vertical" | "horizontal";
interface Ruler {
  type: RulerType;
  startPx: { x: number; y: number };
  endPx: { x: number; y: number };
}

function formatTime(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}\u00b5s`;
  if (us < 1e6) return `${(us / 1000).toFixed(2)}ms`;
  return `${(us / 1e6).toFixed(4)}s`;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="tl-kbd">{children}</kbd>;
}

function drawPill(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number) {
  ctx.font = FONT_MONO;
  const tw = ctx.measureText(text).width;
  const px = 6, py = 4;
  const rw = tw + px * 2, rh = 14 + py * 2;
  const rx = cx - rw / 2, ry = cy - rh / 2;
  ctx.fillStyle = COLOR_ACCENT;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.fillStyle = "#0a0a0b";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
  ctx.textBaseline = "alphabetic";
}

export default function PhaseTimeline({
  data,
  allocs,
  anomalies,
  width,
  height,
  currentRank,
  viewRangeRef: sharedViewRangeRef,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);   // 2D overlay
  const glCanvasRef = useRef<HTMLCanvasElement>(null);  // WebGL strips
  const glRef = useRef<GLState | null>(null);
  const stripKeyRef = useRef("");

  // Imperative state: these change at 60+Hz (pan, drag, ruler move).
  // Keeping them in refs means mousemove/keydown don't cause React to
  // re-render PhaseTimeline. The single rAF loop at the bottom reads
  // these refs each frame and repaints when dirtyRef is set.
  const localViewRangeRef = useRef<[number, number]>([data.time_min, data.time_max]);
  const viewRangeRef = sharedViewRangeRef ?? localViewRangeRef;
  // Track the range we painted last frame; if the shared ref drifts
  // (because the sibling SegmentTimeline panned it), treat it as a
  // cross-view pan and mark dirty to follow along.
  const lastPaintedViewRef = useRef<[number, number]>([data.time_min, data.time_max]);
  // Y-axis view. `manualYRangeRef` overrides auto-fit — set by selection
  // rectangle (drag zoom) or Shift+W/S; null means "auto-fit yMax to the
  // max alloc top in the current X window, floor at 0". `yRangeRef`
  // always holds the range we painted last frame so mouse handlers and
  // hitTest can project bytes ↔ pixels without recomputing.
  const manualYRangeRef = useRef<[number, number] | null>(null);
  const yRangeRef = useRef<[number, number]>([0, 1]);
  const rulerRef = useRef<Ruler | null>(null);
  const selRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const selStartRef = useRef<{ x: number; y: number } | null>(null);
  // Single source of "please repaint". Set by every ref mutation above
  // and by effect setups; the rAF loop clears it after each frame.
  // Default true so first paint happens.
  const dirtyRef = useRef(true);
  const invalidate = () => { dirtyRef.current = true; };

  // Scratch buffers for the per-frame "which allocs intersect viewRange"
  // dedup. Allocating fresh each frame would hit GC hard.
  const visitedBIsRef = useRef<Uint32Array | null>(null);
  const visitGenRef = useRef<number>(0);

  // React state only for click-selection / detail — both low-frequency.
  // Hover lives in refs so 60 Hz cursor movement doesn't re-render.
  const [selectedAlloc, setSelectedAlloc] = useState<TimelineAlloc | null>(null);
  const [detail, setDetail] = useState<AllocationDetail | null>(null);

  const hoverAllocRef = useRef<TimelineAlloc | null>(null);
  const hoverAnomalyRef = useRef<{ anomaly: Anomaly; x: number; y: number } | null>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const hcEyebrowRef = useRef<HTMLDivElement>(null);
  const hcPrimaryRef = useRef<HTMLDivElement>(null);
  const hcSecondaryRef = useRef<HTMLDivElement>(null);
  const hcTertiaryRef = useRef<HTMLDivElement>(null);

  const focusedAddr = useDataStore((s) => s.focusedAddr);
  const focusRange = useDataStore((s) => s.focusRange);
  const animRef = useRef<number>(0);

  useEffect(() => {
    if (!focusRange) return;
    cancelAnimationFrame(animRef.current);
    const from: [number, number] = [...viewRangeRef.current];
    const to = focusRange;
    const start = performance.now();
    const duration = 350;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const ease = t * (2 - t); // ease-out quad
      viewRangeRef.current = [from[0] + (to[0] - from[0]) * ease, from[1] + (to[1] - from[1]) * ease];
      invalidate();
      if (t < 1) animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    canvasRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => cancelAnimationFrame(animRef.current);
    // viewRangeRef + invalidate are imperative (ref + render-loop ping);
    // re-running this effect on their identity would cancel the in-flight
    // animation frame and restart the easing from the current position.
  }, [focusRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusedAddr !== null) {
      const alloc = allocs.find((b) => b.addr === focusedAddr) ?? null;
      setSelectedAlloc(alloc);
      if (alloc) {
        const d = useDataStore.getState().getDetail(currentRank, alloc.addr);
        setDetail(d);
      }
    }
  }, [focusedAddr, allocs, currentRank]);

  const rulerDragRef = useRef<{ type: RulerType; startPx: { x: number; y: number } } | null>(null);
  const keysDownRef = useRef<Set<string>>(new Set());

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const maxBytesFull = useDataStore((s) => s.timelineMaxBytesFull);
  const stripBufferTime = useDataStore((s) => s.timelineStripBuffer);
  const stripBufferEvent = useDataStore((s) => s.timelineStripBufferEvent);
  const xAxisMode = useDataStore((s) => s.xAxisMode);
  // Active buffer for the current X-axis mode. Swapping this drives the
  // WebGL upload + bucket index rebuild. In event mode t values in the
  // buffer are event indices with origin 0; in time mode they're μs
  // relative to data.time_min.
  const stripBuffer = xAxisMode === "event" ? stripBufferEvent : stripBufferTime;
  const timeOrigin = xAxisMode === "event" ? 0 : data.time_min;
  const eventTimesArr = useDataStore((s) => s.eventTimes);
  // Total X-axis range in the same units the stripBuffer uses.
  const totalXRange = xAxisMode === "event"
    ? (eventTimesArr ? Math.max(1, eventTimesArr.length - 1) : 1)
    : (data.time_max - data.time_min);
  const stripCount = useDataStore((s) => s.timelineStripCount);
  const framePool = useDataStore((s) => s.framePool);

  // Pre-bucketed max-y by time. Built once per rank so pan/zoom can
  // compute window-max in O(B) bucket reads (~256) instead of
  // scanning every strip every viewRange change.
  const timeBuckets = useMemo(() => {
    if (!stripBuffer) return null;
    if (totalXRange <= 0) return null;
    const B = 256;
    const bw = totalXRange / B;
    const bMax = new Float32Array(B);
    for (const alloc of allocs) {
      const sz = alloc.size;
      const off0 = alloc.stripOffset;
      const count = alloc.stripCount;
      for (let si = 0; si < count; si++) {
        const off = (off0 + si) * STRIP_FLOATS;
        const ts = stripBuffer[off];       // already normalized vs time_min
        const te = stripBuffer[off + 1];
        const top = stripBuffer[off + 2] + sz;
        const bStart = Math.max(0, Math.floor(ts / bw));
        const bEnd = Math.min(B - 1, Math.floor((te - 1) / bw));
        for (let b = bStart; b <= bEnd; b++) {
          if (top > bMax[b]) bMax[b] = top;
        }
      }
    }
    return { bMax, bw, B };
  }, [allocs, stripBuffer, totalXRange, xAxisMode]);

  // maxBytes is computed inside the rAF loop from viewRangeRef — no
  // useMemo because viewRangeRef isn't reactive. Mouse handlers read
  // yRangeRef (updated every paint) for bytes ↔ pixel projection.
  function computeMaxBytes(): number {
    const [tMin, tMax] = viewRangeRef.current;
    // Full-view fast path. In time mode we compare to [time_min, time_max];
    // in event mode to [0, totalXRange].
    const fullMin = xAxisMode === "event" ? 0 : data.time_min;
    const fullMax = xAxisMode === "event" ? totalXRange : data.time_max;
    if (tMin <= fullMin && tMax >= fullMax && maxBytesFull > 0) {
      return maxBytesFull;
    }
    if (!timeBuckets) return data.peak_bytes * 1.1;
    const { bMax, bw, B } = timeBuckets;
    // Bucket boundaries share units with stripBuffer — view range
    // must be converted to the same frame.
    const originOff = xAxisMode === "event" ? 0 : data.time_min;
    const bStart = Math.max(0, Math.floor((tMin - originOff) / bw));
    const bEnd = Math.min(B - 1, Math.floor((tMax - originOff) / bw));
    let maxB = 0;
    for (let b = bStart; b <= bEnd; b++) if (bMax[b] > maxB) maxB = bMax[b];
    return (maxB || data.peak_bytes) * 1.1;
  }

  useEffect(() => {
    // Reset view + transient selection on rank or X-axis mode change —
    // view-range units differ between modes. viewRangeRef / manualYRangeRef
    // / rulerRef / invalidate are all imperative plumbing; deliberately
    // omitted from deps so this only fires when the x-axis basis changes.
    if (xAxisMode === "event") {
      viewRangeRef.current = [0, totalXRange];
    } else {
      viewRangeRef.current = [data.time_min, data.time_max];
    }
    manualYRangeRef.current = null;
    setSelectedAlloc(null);
    setDetail(null);
    rulerRef.current = null;
    invalidate();
  }, [data.time_min, data.time_max, xAxisMode, totalXRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scale helpers: read the current ref each call, so mouse handlers
  // and hitTest always see the latest pan/zoom without needing the
  // component to re-render.
  const timeToX = useCallback(
    (t: number) => {
      const [vMin, vMax] = viewRangeRef.current;
      return MARGIN.left + ((t - vMin) / (vMax - vMin)) * plotW;
    },
    [plotW],
  );
  const xToTime = useCallback(
    (x: number) => {
      const [vMin, vMax] = viewRangeRef.current;
      return vMin + ((x - MARGIN.left) / plotW) * (vMax - vMin);
    },
    [plotW],
  );
  const bytesToY = useCallback(
    (b: number) => {
      const [yMin, yMax] = yRangeRef.current;
      return MARGIN.top + plotH - ((b - yMin) / (yMax - yMin)) * plotH;
    },
    [plotH],
  );
  const yToBytes = useCallback(
    (y: number) => {
      const [yMin, yMax] = yRangeRef.current;
      return yMin + ((MARGIN.top + plotH - y) / plotH) * (yMax - yMin);
    },
    [plotH],
  );

  // --- WebGL strip upload (zero-copy from pre-packed buffer) ---
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas || !stripBuffer) return;
    if (!glRef.current) glRef.current = initGL(glCanvas);
    if (!glRef.current) return;
    // Include xAxisMode in the cache key — switching modes changes the
    // *values* in stripBuffer (event indices vs μs) without changing
    // rank or stripCount, so a rank-only key stale-GPU's the data.
    const key = `${currentRank}-${stripCount}-${xAxisMode}`;
    if (key !== stripKeyRef.current) {
      uploadStrips(glRef.current, stripBuffer, stripCount);
      stripKeyRef.current = key;
      invalidate();
    }
  }, [stripBuffer, stripCount, currentRank, xAxisMode]);

  // --- Render: WebGL strips + 2D overlay, driven by a single rAF loop ---
  //
  // The loop owns pan/zoom/hover/ruler painting. Mousemove/keyboard
  // updates only touch refs; we read them here each frame. React never
  // re-renders PhaseTimeline during navigation, so hover and drag stay
  // at a solid 60fps regardless of how busy the rest of the page is.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    dirtyRef.current = true;
    let rafId = 0;
    const draw = () => {
      rafId = requestAnimationFrame(draw);
      // Auto-sync: if the sibling view panned the shared viewRange,
      // mark ourselves dirty so we repaint in lockstep.
      const vr = viewRangeRef.current;
      const last = lastPaintedViewRef.current;
      if (vr[0] !== last[0] || vr[1] !== last[1]) dirtyRef.current = true;
      // Skip frame entirely when nothing changed — rAF stays armed so
      // the next mutation gets picked up, but idle CPU drops to ~0.
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      lastPaintedViewRef.current = [vr[0], vr[1]];
      // Y range: manual override (selection drag / Shift+W/S) wins; else
      // anchor yMin at the pre-window baseline so the plot shows only
      // the in-window delta on top. Baseline bytes still exist — they
      // just live off-axis and the bottom tick carries the label.
      let yMin: number, yMax: number;
      if (manualYRangeRef.current) {
        [yMin, yMax] = manualYRangeRef.current;
      } else {
        yMin = data.baseline;
        yMax = computeMaxBytes();
      }
      yRangeRef.current = [yMin, yMax];
      const maxBytes = yMax; // back-compat alias for existing uses below
      const [tMin, tMax] = viewRangeRef.current;
      const ruler = rulerRef.current;
      const selRect = selRectRef.current;

      // WebGL: draw strips (one draw call, GPU-accelerated)
      if (glRef.current) {
        drawStrips(glRef.current, width, height, MARGIN.left, MARGIN.top, plotW, plotH, tMin, tMax, yMin, yMax, timeOrigin);
      }

      // 2D overlay canvas: clear transparent, then fill margins opaque
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, width, MARGIN.top);
      ctx.fillRect(0, MARGIN.top + plotH, width, height - MARGIN.top - plotH);
      ctx.fillRect(0, MARGIN.top, MARGIN.left, plotH);
      ctx.fillRect(MARGIN.left + plotW, MARGIN.top, MARGIN.right, plotH);

      // The pre-window baseline no longer paints a hatched band — the
      // Y axis starts at data.baseline when auto-fitting, and the
      // bottom tick label carries that number. If the user manually
      // Y-pans below baseline (Shift+A), empty space below is fine.

      const yScale = plotH / maxBytes;

      // stripBuffer layout: STRIP_FLOATS floats per strip. In time mode
      // t values are "μs - time_min"; in event mode they're event
      // indices. `timeOrigin` chosen at the top of this component picks
      // the right offset for whichever buffer is active.
      const buf = stripBuffer; // may be null during the first paint before upload
      const t0 = timeOrigin;
      const tMinN = tMin - t0;
      const tMaxN = tMax - t0;

      // Selection highlight — one alloc spans many strips (each strip is
      // a time slice where its y-offset is constant). Group temporally
      // adjacent strips into runs and stroke one polygon per run so the
      // outline traces only the outer contour.
      if (selectedAlloc && buf) {
        ctx.strokeStyle = COLOR_ACCENT;
        ctx.lineWidth = 2;
        const off0 = selectedAlloc.stripOffset;
        const count = selectedAlloc.stripCount;
        const sz = selectedAlloc.size;
        type Seg = { x1: number; x2: number; yTop: number; yBot: number };
        const run: Seg[] = [];
        const flush = () => {
          if (run.length === 0) return;
          ctx.beginPath();
          const first = run[0];
          ctx.moveTo(first.x1, first.yTop);
          for (let j = 0; j < run.length; j++) {
            ctx.lineTo(run[j].x2, run[j].yTop);
            if (j < run.length - 1) ctx.lineTo(run[j + 1].x1, run[j + 1].yTop);
          }
          const last = run[run.length - 1];
          ctx.lineTo(last.x2, last.yBot);
          for (let j = run.length - 1; j >= 0; j--) {
            ctx.lineTo(run[j].x1, run[j].yBot);
            if (j > 0) ctx.lineTo(run[j - 1].x2, run[j - 1].yBot);
          }
          ctx.closePath();
          ctx.stroke();
          run.length = 0;
        };
        let lastTe = -Infinity;
        for (let si = 0; si < count; si++) {
          const off = (off0 + si) * STRIP_FLOATS;
          const ts = buf[off], te = buf[off + 1];
          if (te > tMinN && ts < tMaxN) {
            const yo = buf[off + 2];
            const x1 = Math.max(timeToX(ts + t0), MARGIN.left);
            const x2 = Math.min(timeToX(te + t0), MARGIN.left + plotW);
            if (x2 - x1 >= 0.3) {
              const yTop = bytesToY(yo + sz);
              const yBot = bytesToY(yo);
              if (run.length > 0 && Math.abs(ts - lastTe) > 1e-6) flush();
              run.push({ x1, x2, yTop, yBot });
            }
          }
          lastTe = te;
        }
        flush();
      }

      // Compute visible alloc indices via the time-bucket index.
      // Without this we'd scan all N allocs twice per frame (labels +
      // pending-free overlay), which at 50k allocs = ~100k-plus ops per
      // frame of pure overhead even for allocs entirely off-screen.
      let visibleBIs: Int32Array | null = null;
      let visibleCount = 0;
      if (buf && hitIndex) {
        const { packed, bw, B } = hitIndex;
        const bStart = Math.max(0, Math.floor((tMin - t0) / bw));
        const bEnd = Math.min(B - 1, Math.floor((tMax - t0) / bw));
        let total = 0;
        for (let b = bStart; b <= bEnd; b++) total += packed[b].length;
        visibleBIs = new Int32Array(total);
        // Dedup via a visited Uint8Array — a fresh one per frame is
        // cheaper than allocating a Set. Size is stable once allocs
        // lands; we keep a persistent buffer on visitedBIsRef.
        const vis = (visitedBIsRef.current && visitedBIsRef.current.length >= allocs.length)
          ? visitedBIsRef.current
          : (visitedBIsRef.current = new Uint32Array(allocs.length));
        visitGenRef.current++;
        const gen = visitGenRef.current;
        for (let b = bStart; b <= bEnd; b++) {
          const list = packed[b];
          for (let k = 0; k < list.length; k++) {
            const bi = list[k];
            if (vis[bi] === gen) continue;
            vis[bi] = gen;
            visibleBIs[visibleCount++] = bi;
          }
        }
      }

      // Labels — anchor to each alloc's widest visible strip.
      if (buf) {
        ctx.globalAlpha = 0.92;
        ctx.font = FONT_MONO_SM;
        const n = visibleBIs ? visibleCount : allocs.length;
        for (let idx = 0; idx < n; idx++) {
          const alloc = allocs[visibleBIs ? visibleBIs[idx] : idx];
          let bestX1 = 0, bestY1 = 0, bestW = 0, bestH = 0;
          const off0 = alloc.stripOffset;
          const count = alloc.stripCount;
          for (let si = 0; si < count; si++) {
            const off = (off0 + si) * STRIP_FLOATS;
            const ts = buf[off], te = buf[off + 1];
            if (te <= tMinN || ts >= tMaxN) continue;
            const yo = buf[off + 2];
            const x1 = Math.max(timeToX(ts + t0), MARGIN.left);
            const sw = Math.min(timeToX(te + t0), MARGIN.left + plotW) - x1;
            if (sw > bestW) {
              bestW = sw; bestX1 = x1;
              bestY1 = bytesToY(yo + alloc.size);
              bestH = bytesToY(yo) - bestY1;
            }
          }
          if (bestW < 100 || bestH < 14) continue;
          const label = formatTopFrame(alloc.top_frame_idx, framePool) || `0x${alloc.addr.toString(16)}`;
          const maxChars = Math.floor(bestW / 6.5);
          const text = label.length > maxChars ? label.slice(0, maxChars - 1) + "\u2026" : label;
          ctx.fillStyle = "rgba(250,250,250,0.95)";
          ctx.fillText(text, bestX1 + 4, bestY1 + 12);
          if (bestH > 26) {
            ctx.fillStyle = "rgba(250,250,250,0.55)";
            ctx.fillText(formatBytes(alloc.size), bestX1 + 4, bestY1 + 24);
          }
        }
        ctx.globalAlpha = 1;

        // Pending-free red overlay
        const nPending = visibleBIs ? visibleCount : allocs.length;
        for (let idx = 0; idx < nPending; idx++) {
          const alloc = allocs[visibleBIs ? visibleBIs[idx] : idx];
          if (alloc.free_requested_us <= 0) continue;
          if (alloc.size * yScale < 0.5) continue;
          const frqN = alloc.free_requested_us - t0;
          ctx.fillStyle = "rgba(248,113,113,0.38)";
          const off0 = alloc.stripOffset;
          const count = alloc.stripCount;
          for (let si = 0; si < count; si++) {
            const off = (off0 + si) * STRIP_FLOATS;
            const ts = buf[off], te = buf[off + 1];
            const os = Math.max(ts, frqN);
            if (os >= te || te <= tMinN || os >= tMaxN) continue;
            const yo = buf[off + 2];
            const x1 = Math.max(timeToX(os + t0), MARGIN.left);
            const x2 = Math.min(timeToX(te + t0), MARGIN.left + plotW);
            if (x2 - x1 < 0.5) continue;
            ctx.fillRect(
              x1,
              bytesToY(yo + alloc.size),
              x2 - x1,
              bytesToY(yo) - bytesToY(yo + alloc.size),
            );
          }
        }
      }

      // Anomaly flags — capped to top N by severity to keep the plot readable
      const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
      for (let ai = 0; ai < flagLimit; ai++) {
        const anomaly = anomalies[ai];
        if (anomaly.alloc_us > tMax || anomaly.alloc_us < tMin) continue;
        const x = timeToX(anomaly.alloc_us);
        if (x < MARGIN.left || x > MARGIN.left + plotW) continue;
        const color = ANOMALY_COLORS[anomaly.type] || "#f87171";
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, MARGIN.top); ctx.lineTo(x - FLAG_SIZE / 2, MARGIN.top - FLAG_SIZE); ctx.lineTo(x + FLAG_SIZE / 2, MARGIN.top - FLAG_SIZE);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.22; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(x, MARGIN.top); ctx.lineTo(x, MARGIN.top + plotH); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }

      // Y axis — labels + grid lines
      ctx.fillStyle = COLOR_AXIS; ctx.font = FONT_MONO; ctx.textAlign = "right";
      for (let i = 0; i <= 5; i++) {
        const b = yMin + ((yMax - yMin) / 5) * i, y = bytesToY(b);
        ctx.fillText(formatBytes(b), MARGIN.left - 12, y + 4);
        ctx.strokeStyle = COLOR_GRID; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(MARGIN.left, y); ctx.lineTo(MARGIN.left + plotW, y); ctx.stroke();
      }
      // Y axis label
      ctx.save();
      ctx.translate(16, MARGIN.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillStyle = COLOR_AXIS_DIM;
      ctx.font = FONT_DISPLAY_SM;
      ctx.fillText("BYTES", 0, 0);
      ctx.restore();

      // X axis — ticks + labels
      ctx.textAlign = "center"; ctx.fillStyle = COLOR_AXIS; ctx.font = FONT_MONO;
      const xTicks = Math.min(8, Math.floor(plotW / 100));
      for (let i = 0; i <= xTicks; i++) {
        const t = tMin + ((tMax - tMin) / xTicks) * i;
        const tx = timeToX(t);
        ctx.strokeStyle = COLOR_AXIS_DIM; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(tx, MARGIN.top + plotH); ctx.lineTo(tx, MARGIN.top + plotH + 4); ctx.stroke();
        const label = xAxisMode === "event"
          ? `#${Math.round(t).toLocaleString()}`
          : `${((t - data.time_min) / 1e6).toFixed(2)}s`;
        ctx.fillText(label, tx, height - 14);
      }
      // X axis label
      ctx.textAlign = "right";
      ctx.fillStyle = COLOR_AXIS_DIM;
      ctx.font = FONT_DISPLAY_SM;
      ctx.fillText(xAxisMode === "event" ? "EVENT →" : "TIME →", MARGIN.left + plotW, height - 2);

      // Peak line
      const peakY = bytesToY(data.peak_bytes);
      if (peakY >= MARGIN.top && peakY <= MARGIN.top + plotH) {
        ctx.strokeStyle = "rgba(248,113,113,0.45)"; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(MARGIN.left, peakY); ctx.lineTo(MARGIN.left + plotW, peakY); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = COLOR_PEAK; ctx.textAlign = "left"; ctx.font = FONT_MONO_SM;
        ctx.fillText(`PEAK · ${formatBytes(data.peak_bytes)}`, MARGIN.left + 6, peakY - 5);
      }
      // Border — only bottom + left axis, flat style
      ctx.strokeStyle = COLOR_AXIS_DIM; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, MARGIN.top);
      ctx.lineTo(MARGIN.left, MARGIN.top + plotH);
      ctx.lineTo(MARGIN.left + plotW, MARGIN.top + plotH);
      ctx.stroke();

    // --- Overlay effects (hover, rulers, selection) ---

    // Hover range
    const hoverAlloc = hoverAllocRef.current;
    const hoverAnomaly = hoverAnomalyRef.current;
    if ((hoverAlloc || hoverAnomaly) && !selRect) {
      const hb = hoverAlloc || allocs.find((b) => b.addr === hoverAnomaly?.anomaly.addr);
      if (hb) {
        const rx1 = Math.max(timeToX(hb.alloc_us), MARGIN.left);
        const rx2 = Math.min(timeToX(hb.free_us), MARGIN.left + plotW);
        ctx.fillStyle = "rgba(217,249,157,0.05)";
        ctx.fillRect(rx1, MARGIN.top, rx2 - rx1, plotH);
        ctx.strokeStyle = "rgba(217,249,157,0.45)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        if (rx1 >= MARGIN.left) { ctx.moveTo(rx1, MARGIN.top); ctx.lineTo(rx1, MARGIN.top + plotH); }
        if (rx2 <= MARGIN.left + plotW) { ctx.moveTo(rx2, MARGIN.top); ctx.lineTo(rx2, MARGIN.top + plotH); }
        ctx.stroke(); ctx.setLineDash([]);
        if (hb.free_requested_us > 0 && hb.free_requested_us < hb.free_us) {
          const px1 = Math.max(timeToX(hb.free_requested_us), MARGIN.left);
          const px2 = Math.min(timeToX(hb.free_us), MARGIN.left + plotW);
          ctx.fillStyle = "rgba(248,113,113,0.12)"; ctx.fillRect(px1, MARGIN.top, px2 - px1, plotH);
          ctx.strokeStyle = "rgba(248,113,113,0.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.beginPath();
          if (px1 >= MARGIN.left) { ctx.moveTo(px1, MARGIN.top); ctx.lineTo(px1, MARGIN.top + plotH); }
          if (px2 <= MARGIN.left + plotW) { ctx.moveTo(px2, MARGIN.top); ctx.lineTo(px2, MARGIN.top + plotH); }
          ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }

    // Ruler
    if (ruler) {
      const { type, startPx, endPx } = ruler;
      ctx.save(); ctx.lineWidth = 1.5;
      if (type === "vertical") {
        const x = startPx.x, yTop = Math.min(startPx.y, endPx.y), yBot = Math.max(startPx.y, endPx.y);
        ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(217,249,157,0.4)";
        ctx.beginPath(); ctx.moveTo(MARGIN.left, yTop); ctx.lineTo(MARGIN.left + plotW, yTop);
        ctx.moveTo(MARGIN.left, yBot); ctx.lineTo(MARGIN.left + plotW, yBot); ctx.stroke();
        ctx.setLineDash([]); ctx.strokeStyle = COLOR_ACCENT;
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
        ctx.moveTo(x - 6, yTop); ctx.lineTo(x + 6, yTop); ctx.moveTo(x - 6, yBot); ctx.lineTo(x + 6, yBot); ctx.stroke();
        const bTop = yToBytes(yTop), bBot = yToBytes(yBot);
        drawPill(ctx, formatBytes(bTop), x + 50, yTop); drawPill(ctx, formatBytes(bBot), x + 50, yBot);
        drawPill(ctx, `\u0394 ${formatBytes(Math.abs(bTop - bBot))}`, x + 50, (yTop + yBot) / 2);
      } else {
        const y = startPx.y, xL = Math.min(startPx.x, endPx.x), xR = Math.max(startPx.x, endPx.x);
        ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(217,249,157,0.4)";
        ctx.beginPath(); ctx.moveTo(xL, MARGIN.top); ctx.lineTo(xL, MARGIN.top + plotH);
        ctx.moveTo(xR, MARGIN.top); ctx.lineTo(xR, MARGIN.top + plotH); ctx.stroke();
        ctx.setLineDash([]); ctx.strokeStyle = COLOR_ACCENT;
        ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y);
        ctx.moveTo(xL, y - 6); ctx.lineTo(xL, y + 6); ctx.moveTo(xR, y - 6); ctx.lineTo(xR, y + 6); ctx.stroke();
        const tL = xToTime(xL), tR = xToTime(xR), delta = Math.abs(tR - tL);
        const fmt = xAxisMode === "event"
          ? (v: number) => `#${Math.round(v).toLocaleString()}`
          : (v: number) => formatTime(v - data.time_min);
        drawPill(ctx, fmt(tL), xL, y - 16); drawPill(ctx, fmt(tR), xR, y - 16);
        drawPill(
          ctx,
          xAxisMode === "event"
            ? `\u0394 ${Math.round(delta).toLocaleString()} evt`
            : `\u0394 ${formatTime(delta)}`,
          (xL + xR) / 2,
          y + 16,
        );
      }
      ctx.restore();
    }

    // Selection rectangle
    if (selRect) {
      const sx1 = Math.min(selRect.x1, selRect.x2), sy1 = Math.min(selRect.y1, selRect.y2);
      const sw = Math.abs(selRect.x2 - selRect.x1), sh = Math.abs(selRect.y2 - selRect.y1);
      ctx.fillStyle = "rgba(10,10,11,0.55)";
      ctx.fillRect(MARGIN.left, MARGIN.top, plotW, sy1 - MARGIN.top);
      ctx.fillRect(MARGIN.left, sy1 + sh, plotW, MARGIN.top + plotH - sy1 - sh);
      ctx.fillRect(MARGIN.left, sy1, sx1 - MARGIN.left, sh);
      ctx.fillRect(sx1 + sw, sy1, MARGIN.left + plotW - sx1 - sw, sh);
      ctx.strokeStyle = COLOR_ACCENT; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx1, sy1, sw, sh); ctx.setLineDash([]);
    }
    }; // end of draw fn
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  // Deps intentionally minimal — the rAF loop re-reads refs every
  // frame, so we only restart the loop when inputs that feed draw()
  // but live in React land actually change.
  // hoverAlloc / hoverAnomaly are NOT in deps: they live in refs and
  // the rAF loop picks up changes via invalidate(). Adding them would
  // undo the whole point of the refactor.
  }, [data, allocs, stripBuffer, anomalies, width, height, timeToX, xToTime, bytesToY, yToBytes, plotW, plotH, selectedAlloc, timeBuckets, framePool, maxBytesFull]);

  // Bucketed hit index: each time bucket lists the alloc indices whose
  // strips intersect that bucket. hitTest only scans candidates for the
  // cursor's bucket — O(N/B) vs O(N) at 20k+ allocs.
  const hitIndex = useMemo(() => {
    if (!stripBuffer) return null;
    if (totalXRange <= 0) return null;
    const B = 256;
    const bw = totalXRange / B;
    const lists: Set<number>[] = Array.from({ length: B }, () => new Set());
    for (let bi = 0; bi < allocs.length; bi++) {
      const alloc = allocs[bi];
      const off0 = alloc.stripOffset;
      const count = alloc.stripCount;
      for (let si = 0; si < count; si++) {
        const off = (off0 + si) * STRIP_FLOATS;
        const ts = stripBuffer[off];
        const te = stripBuffer[off + 1];
        const bStart = Math.max(0, Math.floor(ts / bw));
        const bEnd = Math.min(B - 1, Math.floor((te - 1) / bw));
        for (let b = bStart; b <= bEnd; b++) lists[b].add(bi);
      }
    }
    const packed = lists.map((s) => {
      const a = new Int32Array(s.size);
      let i = 0;
      for (const v of s) a[i++] = v;
      return a;
    });
    return { packed, bw, B };
  }, [allocs, stripBuffer, totalXRange]);

  const hitTest = useCallback(
    (mx: number, my: number): TimelineAlloc | null => {
      if (mx < MARGIN.left || mx > MARGIN.left + plotW) return null;
      if (my < MARGIN.top || my > MARGIN.top + plotH) return null;
      if (!stripBuffer) return null;
      const t = xToTime(mx);
      const mouseBytes = yToBytes(my);
      if (mouseBytes < 0) return null;
      const tN = t - timeOrigin;

      if (hitIndex) {
        const { packed, bw, B } = hitIndex;
        const bIdx = Math.min(B - 1, Math.max(0, Math.floor(tN / bw)));
        const cand = packed[bIdx];
        // Scan newest-first so later allocations win on overlap (matches
        // the previous full-scan's visual layering).
        for (let k = cand.length - 1; k >= 0; k--) {
          const bi = cand[k];
          const alloc = allocs[bi];
          const off0 = alloc.stripOffset;
          const count = alloc.stripCount;
          const sz = alloc.size;
          for (let si = 0; si < count; si++) {
            const off = (off0 + si) * STRIP_FLOATS;
            const ts = stripBuffer[off];
            const te = stripBuffer[off + 1];
            if (tN < ts || tN >= te) continue;
            const yo = stripBuffer[off + 2];
            if (mouseBytes >= yo && mouseBytes < yo + sz) return alloc;
            break;
          }
        }
        return null;
      }

      // Fallback (no stripBuffer): full scan.
      for (let bi = allocs.length - 1; bi >= 0; bi--) {
        const alloc = allocs[bi];
        const off0 = alloc.stripOffset;
        const count = alloc.stripCount;
        const sz = alloc.size;
        for (let si = 0; si < count; si++) {
          const off = (off0 + si) * STRIP_FLOATS;
          const ts = stripBuffer[off];
          const te = stripBuffer[off + 1];
          if (tN < ts || tN >= te) continue;
          const yo = stripBuffer[off + 2];
          if (mouseBytes >= yo && mouseBytes < yo + sz) return alloc;
          break;
        }
      }
      return null;
    },
    [allocs, stripBuffer, timeOrigin, xToTime, yToBytes, plotW, plotH, hitIndex],
  );

  // rAF-throttle the hover hit-test. For 20k+ allocs the per-mousemove
  // scan would otherwise eat 5-10ms each at 60+Hz, dropping frames on
  // the canvas redraw that hoverAlloc itself triggers.
  const hoverRafRef = useRef<number | null>(null);
  const hoverPendingRef = useRef<{ mx: number; my: number } | null>(null);

  // Imperative DOM update for the hover card. Bypasses React entirely
  // so 60Hz hover motion doesn't re-render this 1000-line component.
  const updateHoverCard = useCallback(() => {
    const card = hoverCardRef.current;
    if (!card) return;
    const hb = hoverAllocRef.current;
    const ha = hoverAnomalyRef.current;
    if (!hb && !ha) {
      if (card.style.display !== "none") card.style.display = "none";
      return;
    }
    const eb = hcEyebrowRef.current!;
    const pr = hcPrimaryRef.current!;
    const se = hcSecondaryRef.current!;
    const te = hcTertiaryRef.current!;
    if (ha) {
      const color = ANOMALY_COLORS[ha.anomaly.type];
      card.style.borderLeft = `2px solid ${color}`;
      eb.style.color = color;
      eb.textContent = ha.anomaly.type === "pending_free" ? "Pending Free" : "Leak Suspect";
      pr.textContent = formatBytes(ha.anomaly.size);
      se.textContent = ha.anomaly.label;
      te.textContent = formatTopFrame(ha.anomaly.top_frame_idx, framePool);
    } else if (hb) {
      card.style.borderLeft = "2px solid var(--accent)";
      eb.style.color = "var(--fg-faint)";
      eb.textContent = "Block";
      pr.textContent = formatBytes(hb.size);
      se.textContent = formatTopFrame(hb.top_frame_idx, framePool) || `0x${hb.addr.toString(16)}`;
      const dur = ((hb.free_us - hb.alloc_us) / 1e6).toFixed(4);
      te.textContent = hb.alive ? `${dur}s · alive` : `${dur}s`;
    }
    card.style.display = "block";
  }, [framePool]);

  const runHoverDetection = useCallback(() => {
    hoverRafRef.current = null;
    const pos = hoverPendingRef.current;
    hoverPendingRef.current = null;
    if (!pos) return;
    const { mx, my } = pos;

    // Compute new hover targets first; only commit + redraw if anything
    // actually changed. (Equivalent to React's automatic bail-out when
    // setState is called with the same identity — which we lost going
    // imperative. Without this, mouse-moves inside a single alloc
    // trigger a redraw every frame.)
    let nextAnomaly: { anomaly: Anomaly; x: number; y: number } | null = null;
    let nextBlock: TimelineAlloc | null = null;
    if (my < MARGIN.top && my >= MARGIN.top - FLAG_SIZE - 2) {
      const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
      for (let ai = 0; ai < flagLimit; ai++) {
        const anomaly = anomalies[ai];
        const fx = timeToX(anomaly.alloc_us);
        if (Math.abs(mx - fx) < FLAG_SIZE) {
          nextAnomaly = { anomaly, x: mx, y: my };
          break;
        }
      }
    }
    if (!nextAnomaly) nextBlock = hitTest(mx, my);

    const prevAnomaly = hoverAnomalyRef.current;
    const prevBlock = hoverAllocRef.current;
    const anomalySame = prevAnomaly?.anomaly === nextAnomaly?.anomaly;
    if (anomalySame && prevBlock === nextBlock) return;

    hoverAnomalyRef.current = nextAnomaly;
    hoverAllocRef.current = nextBlock;
    updateHoverCard();
    invalidate();
  }, [anomalies, timeToX, hitTest, updateHoverCard]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Ruler dragging — clamp to plot area, update immediately.
      if (rulerDragRef.current) {
        const { type, startPx } = rulerDragRef.current;
        const cy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
        const cx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
        const endPx = type === "vertical" ? { x: startPx.x, y: cy } : { x: cx, y: startPx.y };
        rulerRef.current = { type, startPx, endPx };
        invalidate();
        return;
      }

      // Selection rectangle dragging — immediate.
      if (selStartRef.current) {
        const cx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
        const cy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
        selRectRef.current = { x1: selStartRef.current.x, y1: selStartRef.current.y, x2: cx, y2: cy };
        invalidate();
        return;
      }

      // Non-drag hover — coalesce to rAF so fast mouse motion doesn't
      // trigger N hitTests per frame.
      hoverPendingRef.current = { mx, my };
      if (hoverRafRef.current === null) {
        hoverRafRef.current = requestAnimationFrame(runHoverDetection);
      }
    },
    [plotW, plotH, runHoverDetection],
  );


  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysDownRef.current.add(key);

      // Escape dismisses ruler
      if (key === "escape") {
        rulerRef.current = null;
        rulerDragRef.current = null;
        invalidate();
        e.preventDefault();
        return;
      }

      // Ctrl+C / Cmd+C copies stack trace
      if (key === "c" && (e.ctrlKey || e.metaKey) && detail) {
        const text = detail.frames
          .filter(f => f.filename !== "??" && !f.name.includes("CUDACachingAllocator") && !f.filename.includes("memory_snapshot"))
          .map(f => `${f.name} @ ${f.filename}:${f.line}`)
          .join("\n");
        navigator.clipboard.writeText(`${formatBytes(detail.size)} 0x${detail.addr.toString(16)}\n${text}`);
        e.preventDefault();
        return;
      }

      // Navigation keys are handled by rAF loop below
      if ("adws".includes(key) || key.startsWith("arrow")) {
        e.preventDefault();
      }
    },
    [detail],
  );

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    keysDownRef.current.delete(e.key.toLowerCase());
  }, []);

  // Continuous smooth navigation via rAF while WASD/arrows are held.
  // Writes viewRangeRef directly; the render loop above picks it up.
  const navRafRef = useRef<number>(0);

  useEffect(() => {
    let running = true;
    function tick() {
      if (!running) return;
      const keys = keysDownRef.current;
      const shift = keys.has("shift");
      const hasYZoom = shift && (keys.has("w") || keys.has("s") || keys.has("arrowup") || keys.has("arrowdown"));
      const hasYPan  = shift && (keys.has("a") || keys.has("d") || keys.has("arrowleft") || keys.has("arrowright"));
      const hasXNav = !shift && (keys.has("a") || keys.has("d") || keys.has("w") || keys.has("s")
        || keys.has("arrowleft") || keys.has("arrowright") || keys.has("arrowup") || keys.has("arrowdown"));

      if (hasYZoom) {
        // Shift+W/S → zoom Y around the view center. Seeds manual range
        // from the current auto-fit the first time, then grows/shrinks it.
        const zoomRate = 0.97;
        let cur = manualYRangeRef.current;
        if (!cur) cur = [yRangeRef.current[0], yRangeRef.current[1]];
        const [yMin0, yMax0] = cur;
        const span = yMax0 - yMin0;
        const c = (yMin0 + yMax0) / 2;
        const peakCap = (data.peak_bytes || yMax0) * 1.1;
        let nYMin = yMin0, nYMax = yMax0;
        if (keys.has("w") || keys.has("arrowup")) {
          const ns = span * zoomRate;
          if (ns > Math.max(1, peakCap * 0.001)) {
            nYMin = Math.max(0, c - ns / 2);
            nYMax = nYMin + ns;
          }
        }
        if (keys.has("s") || keys.has("arrowdown")) {
          const ns = Math.min(peakCap, span / zoomRate);
          nYMin = Math.max(0, c - ns / 2);
          nYMax = Math.min(peakCap, nYMin + ns);
        }
        if (nYMin !== yMin0 || nYMax !== yMax0) {
          manualYRangeRef.current = [nYMin, nYMax];
          invalidate();
        }
      }

      if (hasYPan) {
        // Shift+A/D → pan Y. D (right) scrolls toward larger bytes
        // (upward in the plot); A (left) toward the baseline. Seeds
        // from auto-fit on first use so the first keystroke doesn't
        // collapse the view.
        let cur = manualYRangeRef.current;
        if (!cur) cur = [yRangeRef.current[0], yRangeRef.current[1]];
        const [yMin0, yMax0] = cur;
        const span = yMax0 - yMin0;
        const peakCap = (data.peak_bytes || yMax0) * 1.1;
        const panRate = span * 0.02;
        let nYMin = yMin0, nYMax = yMax0;
        if (keys.has("d") || keys.has("arrowright")) {
          nYMax = Math.min(peakCap, yMax0 + panRate);
          nYMin = nYMax - span;
        }
        if (keys.has("a") || keys.has("arrowleft")) {
          nYMin = Math.max(0, yMin0 - panRate);
          nYMax = nYMin + span;
        }
        if (nYMin !== yMin0 || nYMax !== yMax0) {
          manualYRangeRef.current = [nYMin, nYMax];
          invalidate();
        }
      }

      if (hasXNav) {
        const [tMin, tMax] = viewRangeRef.current;
        const range = tMax - tMin;
        // Bounds track whichever axis mode is active.
        const absMin = xAxisMode === "event" ? 0 : data.time_min;
        const absMax = xAxisMode === "event" ? totalXRange : data.time_max;
        const fullRange = absMax - absMin;
        const panRate = range * 0.02; // 2% per frame (~60fps = smooth scroll)
        const zoomRate = 0.97; // zoom in 3% per frame
        // Minimum visible span: 100 μs in time mode, 1 event in event mode.
        const minRange = xAxisMode === "event" ? 1 : 100;
        let newMin = tMin, newMax = tMax;

        if (keys.has("a") || keys.has("arrowleft")) {
          newMin = Math.max(absMin, tMin - panRate);
          newMax = newMin + range;
        }
        if (keys.has("d") || keys.has("arrowright")) {
          newMax = Math.min(absMax, tMax + panRate);
          newMin = newMax - range;
        }
        if (keys.has("w") || keys.has("arrowup")) {
          const nr = range * zoomRate;
          if (nr > minRange) {
            const c = (newMin + newMax) / 2;
            newMin = Math.max(absMin, c - nr / 2);
            newMax = Math.min(absMax, newMin + nr);
          }
        }
        if (keys.has("s") || keys.has("arrowdown")) {
          const nr = Math.min(fullRange, range / zoomRate);
          const c = (newMin + newMax) / 2;
          newMin = Math.max(absMin, c - nr / 2);
          newMax = Math.min(absMax, newMin + nr);
        }

        if (newMin !== tMin || newMax !== tMax) {
          viewRangeRef.current = [newMin, newMax];
          invalidate();
        }
      }
      navRafRef.current = requestAnimationFrame(tick);
    }
    navRafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(navRafRef.current); };
    // Refs + data.peak_bytes change with the same rank swap that already
    // re-fires via data.time_min/max; intentionally omitted.
  }, [data.time_min, data.time_max, xAxisMode, totalXRange]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).focus();
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Start ruler if R or T is held — clamp to plot area
      const cy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
      const cx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
      if (keysDownRef.current.has("r")) {
        rulerDragRef.current = { type: "vertical", startPx: { x: cx, y: cy } };
        return;
      }
      if (keysDownRef.current.has("t")) {
        rulerDragRef.current = { type: "horizontal", startPx: { x: cx, y: cy } };
        return;
      }

      // Start selection rectangle
      const sx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
      const sy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
      selStartRef.current = { x: sx, y: sy };
    },
    [plotW, plotH],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      // Finish ruler drag
      if (rulerDragRef.current) {
        rulerDragRef.current = null;
        return;
      }

      if (selStartRef.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const dx = Math.abs(mx - selStartRef.current.x);
        const dy = Math.abs(my - selStartRef.current.y);

        if (dx > 5 || dy > 5) {
          // Selection rectangle → zoom both X and Y into the region.
          // Clamp to plot bounds so dragging past the axis doesn't produce
          // a negative / out-of-range span.
          const cx1 = Math.max(MARGIN.left, Math.min(selStartRef.current.x, mx));
          const cx2 = Math.min(MARGIN.left + plotW, Math.max(selStartRef.current.x, mx));
          const cy1 = Math.max(MARGIN.top, Math.min(selStartRef.current.y, my));
          const cy2 = Math.min(MARGIN.top + plotH, Math.max(selStartRef.current.y, my));
          const newTMin = xToTime(cx1);
          const newTMax = xToTime(cx2);
          const minSpan = xAxisMode === "event" ? 1 : 100;
          if (newTMax - newTMin > minSpan) {
            viewRangeRef.current = [newTMin, newTMax];
          }
          // Y: top of rect → larger bytes, bottom → smaller. Only commit
          // if the drag is tall enough to distinguish from a pure X drag.
          if (Math.abs(cy2 - cy1) > 8) {
            const [yMinCur, yMaxCur] = yRangeRef.current;
            const bTop = yToBytes(cy1);
            const bBot = yToBytes(cy2);
            const minY = Math.max(0, Math.min(bTop, bBot));
            const maxY = Math.min(yMaxCur, Math.max(bTop, bBot));
            if (maxY - minY > (yMaxCur - yMinCur) * 0.01) {
              manualYRangeRef.current = [minY, maxY];
            }
          }
          invalidate();
        } else {
          // Click — flag or alloc selection
          if (my < MARGIN.top && my >= MARGIN.top - FLAG_SIZE - 2) {
            const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
            for (let ai = 0; ai < flagLimit; ai++) {
              const anomaly = anomalies[ai];
              const fx = timeToX(anomaly.alloc_us);
              if (Math.abs(mx - fx) < FLAG_SIZE) {
                const alloc = allocs.find((b) => b.addr === anomaly.addr) ?? null;
                setSelectedAlloc(alloc);
                const d = useDataStore.getState().getDetail(currentRank, anomaly.addr);
                setDetail(d);
                selStartRef.current = null;
                selRectRef.current = null;
                invalidate();
                return;
              }
            }
          }
          const hit = hitTest(mx, my);
          setSelectedAlloc(hit);
          const d = hit ? useDataStore.getState().getDetail(currentRank, hit.addr) : null;
          setDetail(d);
        }
      }
      selStartRef.current = null;
      selRectRef.current = null;
      invalidate();
    },
    [hitTest, currentRank, anomalies, allocs, timeToX],
  );

  const cursorStyle = rulerDragRef.current
    ? (rulerDragRef.current.type === "vertical" ? "ns-resize" : "ew-resize")
    : "crosshair";

  return (
    <div>
      <div style={{ position: "relative", cursor: cursorStyle }}>
        <canvas
          ref={glCanvasRef}
          style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
        />
        <canvas
          ref={canvasRef}
          style={{ position: "relative", background: "transparent" }}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onMouseMove={handleMouseMove}

          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            if (hoverRafRef.current !== null) {
              cancelAnimationFrame(hoverRafRef.current);
              hoverRafRef.current = null;
            }
            hoverPendingRef.current = null;
            hoverAllocRef.current = null;
            hoverAnomalyRef.current = null;
            updateHoverCard();
            selStartRef.current = null;
            selRectRef.current = null;
            if (rulerDragRef.current) rulerDragRef.current = null;
            invalidate();
          }}
          onDoubleClick={() => {
            if (xAxisMode === "event") viewRangeRef.current = [0, totalXRange];
            else viewRangeRef.current = [data.time_min, data.time_max];
            manualYRangeRef.current = null;
            invalidate();
          }}
        />
        {/* Hover card skeleton — content is written imperatively by
            updateHoverCard() to avoid re-rendering PhaseTimeline on
            every mousemove. display:none when not hovered. */}
        <div
          ref={hoverCardRef}
          className="tl-hover-card"
          style={{
            right: MARGIN.right + 8,
            top: MARGIN.top + 8,
            display: "none",
            borderLeft: "2px solid var(--accent)",
          }}
        >
          <div
            ref={hcEyebrowRef}
            className="display"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: 4,
              color: "var(--fg-faint)",
            }}
          />
          <div
            ref={hcPrimaryRef}
            className="mono"
            style={{ color: "var(--fg)", fontSize: 14, marginBottom: 2 }}
          />
          <div
            ref={hcSecondaryRef}
            className="mono"
            style={{ color: "var(--fg-muted)", fontSize: 11, marginBottom: 2 }}
          />
          <div
            ref={hcTertiaryRef}
            className="mono faint"
            style={{ fontSize: 10 }}
          />
        </div>
      </div>

      {/* Always-visible keyboard shortcut bar, outside the canvas so it
          never gets hidden by tooltips or dark plot backgrounds. */}
      <div className="tl-hint mono">
        <Kbd>WASD</Kbd>
        <span>pan/zoom X</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>⇧WASD</Kbd>
        <span>pan/zoom Y</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>R</Kbd><span>+drag</span>
        <span>mem ruler</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>T</Kbd><span>+drag</span>
        <span>time ruler</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>drag</Kbd>
        <span>zoom to box</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>dblclick</Kbd>
        <span>reset</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>Esc</Kbd>
        <span>clear</span>
        <span className="tl-hint-sep">·</span>
        <Kbd>⌘C</Kbd>
        <span>copy trace</span>
      </div>

      {/* detail panel */}
      {detail && (
        <div className="tl-detail">
          <div className="tl-detail-head">
            <div className="stat">
              <span className="stat-label">Size</span>
              <span className="stat-value" style={{ fontSize: 18 }}>{formatBytes(detail.size)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Duration</span>
              <span className="stat-value" style={{ fontSize: 18 }}>
                {detail.free_us === -1
                  ? "alive"
                  : `${((detail.free_us - detail.alloc_us) / 1e6).toFixed(4)}s`}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Address</span>
              <span className="stat-value mono" style={{ fontSize: 14 }}>
                0x{detail.addr.toString(16)}
              </span>
            </div>
            <div
              className="mono"
              style={{
                marginLeft: "auto",
                alignSelf: "flex-end",
                fontSize: 10,
                color: "var(--fg-faint)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              ⌘C copy trace
            </div>
          </div>
          <div className="tl-detail-trace mono">
            {detail.frames
              .filter(
                (f) =>
                  f.filename !== "??" &&
                  !f.name.includes("CUDACachingAllocator") &&
                  !f.filename.includes("memory_snapshot"),
              )
              .map((f, i) => {
                const isPython = f.filename.includes(".py");
                return (
                  <div key={i} className="tl-frame" data-py={isPython ? "1" : "0"}>
                    <span className="tl-frame-name">
                      {f.name.length > 100 ? f.name.slice(0, 97) + "…" : f.name}
                    </span>
                    {f.filename && (
                      <span className="tl-frame-loc">
                        {" @ "}{f.filename.split("/").slice(-2).join("/")}:{f.line}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <style>{`
        .tl-tooltip {
          position: absolute;
          background: rgba(10,10,11,0.96);
          border: 1px solid var(--border-strong);
          padding: 10px 14px;
          font-size: 12px;
          pointer-events: none;
          max-width: 360px;
          line-height: 1.5;
          backdrop-filter: blur(12px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        }
        .tl-hover-card {
          position: absolute;
          background: rgba(10,10,11,0.55);
          border: 1px solid rgba(42,42,47,0.6);
          padding: 10px 14px;
          font-size: 12px;
          pointer-events: none;
          max-width: 340px;
          min-width: 180px;
          line-height: 1.5;
          backdrop-filter: blur(16px) saturate(1.1);
          -webkit-backdrop-filter: blur(16px) saturate(1.1);
          z-index: 3;
        }
        .tl-hint {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          margin-top: 8px;
          padding: 8px 12px;
          border-top: 1px solid var(--divider);
          font-size: 11px;
          color: var(--fg-muted);
          letter-spacing: 0.02em;
        }
        .tl-hint-sep {
          color: var(--fg-dim);
          margin: 0 4px;
        }
        .tl-hint-slash {
          color: var(--fg-dim);
          margin: 0 2px;
        }
        .tl-kbd {
          display: inline-flex;
          align-items: center;
          padding: 1px 6px;
          min-width: 20px;
          justify-content: center;
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 500;
          color: var(--fg);
          background: var(--bg-elev-2);
          border: 1px solid var(--border-strong);
          border-bottom-width: 2px;
          letter-spacing: 0.04em;
        }
        .tl-detail {
          margin-top: 16px;
          background: var(--bg-elev);
          border: 1px solid var(--border);
          border-left: 2px solid var(--accent);
          padding: 20px 24px;
          max-height: 320px;
          overflow: auto;
        }
        .tl-detail-head {
          display: flex;
          gap: var(--s7);
          margin-bottom: 16px;
          padding-bottom: 14px;
          border-bottom: 1px solid var(--divider);
        }
        .tl-detail-trace {
          font-size: 11px;
          line-height: 1.7;
        }
        .tl-frame {
          color: var(--fg-dim);
          padding: 1px 0;
        }
        .tl-frame[data-py="1"] { color: var(--fg-muted); }
        .tl-frame[data-py="1"] .tl-frame-loc { color: var(--accent); opacity: 0.8; }
        .tl-frame-name { color: inherit; }
        .tl-frame-loc { color: var(--fg-dim); }
      `}</style>
    </div>
  );
}
