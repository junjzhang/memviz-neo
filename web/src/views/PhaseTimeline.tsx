import { useRef, useEffect, useCallback, useMemo } from "react";
import type {
  TimelineData,
  TimelineAlloc,
} from "../types/timeline";
import { STRIP_FLOATS } from "../types/timeline";
import { formatBytes, formatTopFrame } from "../utils";
import { useDataStore } from "../stores/dataStore";
import { eventIdxAt } from "../compute/eventTimes";
import { buildStripIndex } from "../compute/stripIndex";
import { initGL, uploadStrips, drawStrips, type GLState } from "./glRenderer";
import { useNavigation } from "./phaseTimeline/useNavigation";
import { drawRuler, drawSelectionRect, type Ruler, type RulerType } from "./phaseTimeline/overlays";

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

  const hoverAllocRef = useRef<TimelineAlloc | null>(null);
  const hoverAnomalyRef = useRef<{ anomaly: Anomaly; x: number; y: number } | null>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const hcEyebrowRef = useRef<HTMLDivElement>(null);
  const hcPrimaryRef = useRef<HTMLDivElement>(null);
  const hcSecondaryRef = useRef<HTMLDivElement>(null);
  const hcTertiaryRef = useRef<HTMLDivElement>(null);

  // Selection lives in dataStore so SegmentTimeline can set it too.
  // PhaseTimeline's only job on click is to call setSelectedAlloc — the
  // selected rectangle we draw here is derived from that store field.
  const focusedAddr = useDataStore((s) => s.focusedAddr);
  const focusRange = useDataStore((s) => s.focusRange);
  const storeSelectedAlloc = useDataStore((s) => s.selectedAlloc);
  const setSelectedAlloc = useDataStore((s) => s.setSelectedAlloc);
  const animRef = useRef<number>(0);

  const selectedAlloc = useMemo<TimelineAlloc | null>(
    () => {
      if (!storeSelectedAlloc) return null;
      return allocs.find(
        (a) => a.addr === storeSelectedAlloc.addr && a.alloc_us === storeSelectedAlloc.alloc_us,
      ) ?? null;
    },
    [storeSelectedAlloc, allocs],
  );

  useEffect(() => {
    if (!focusRange) return;
    cancelAnimationFrame(animRef.current);
    const from: [number, number] = [...viewRangeRef.current];
    // focusRange lives in μs (the anomaly's alloc/free wall-clock). In
    // event mode viewRangeRef holds event indices, so convert before
    // easing or the animation lands at garbage coordinates.
    const mode = useDataStore.getState().xAxisMode;
    const evt = useDataStore.getState().eventTimes;
    const to: [number, number] =
      mode === "event" && evt && evt.length > 0
        ? [
            eventIdxAt(evt, focusRange[0] - data.time_min),
            eventIdxAt(evt, focusRange[1] - data.time_min),
          ]
        : focusRange;
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
    return () => cancelAnimationFrame(animRef.current);
    // viewRangeRef + invalidate are imperative (ref + render-loop ping);
    // re-running this effect on their identity would cancel the in-flight
    // animation frame and restart the easing from the current position.
  }, [focusRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusedAddr == null) return;
    // Focus arrives as addr-only (from anomaly panel), so disambiguate
    // via alloc_us by matching it against the in-memory allocs list.
    const a = allocs.find((x) => x.addr === focusedAddr);
    if (a) setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
  }, [focusedAddr, allocs, setSelectedAlloc]);

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

  // One-pass bucket index: per-bucket max-y (Y auto-fit) + per-bucket
  // candidate alloc lists (hit-test). O(B) reads per frame instead of
  // O(N allocs).
  const stripIndex = useMemo(
    () => (stripBuffer ? buildStripIndex(allocs, stripBuffer, totalXRange) : null),
    [allocs, stripBuffer, totalXRange, xAxisMode],
  );

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
    if (!stripIndex) return data.peak_bytes * 1.1;
    const { bMax, bw, B } = stripIndex;
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
  // Absolute μs → whatever the view's X-axis is. In time mode that's
  // absolute μs (viewRange is absolute). In event mode, map to the
  // event-index space stripBuffer uses. Anomaly flags + hover-range
  // overlays need this because they carry raw alloc_us values, not
  // stripBuffer-normalized ones.
  const usToView = useCallback(
    (us: number) => {
      if (xAxisMode !== "event" || !eventTimesArr || eventTimesArr.length === 0) return us;
      return eventIdxAt(eventTimesArr, us - data.time_min);
    },
    [xAxisMode, eventTimesArr, data.time_min],
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
      if (buf && stripIndex) {
        const { packed, bw, B } = stripIndex;
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

      // Labels — anchor to each alloc's widest visible strip. Hoist the
      // view transform out of the inner loop (ref read + 3 ops per call
      // × ~100k calls = our zoom slowdown) and early-break once strips
      // slide past the right edge: stripBuffer is time-ordered per alloc.
      if (buf) {
        ctx.globalAlpha = 0.92;
        ctx.font = FONT_MONO_SM;
        const plotLeftM = MARGIN.left;
        const plotRightM = MARGIN.left + plotW;
        const plotBotM = MARGIN.top + plotH;
        const xSpan = tMaxN - tMinN || 1;
        const xScale = plotW / xSpan;
        const ySpanB = maxBytes - yMin || 1;
        const yScaleB = plotH / ySpanB;
        const n = visibleBIs ? visibleCount : allocs.length;
        // Two upper-bound filters before the per-strip scan:
        //   1. alloc.size is the bar's height in bytes; if it renders to
        //      fewer than 14 px it can't fit a label regardless of view.
        //   2. the alloc's full visible span (its [firstTs, lastTe] ∩ view)
        //      is an upper bound on any single strip's clamped width;
        //      if < 100 px there's no room for a label either.
        // Both checks are ~O(1) per alloc; together they cut a 17k-alloc
        // crowded-view frame from ~50 ms of pointless scanning to ~1 ms.
        const minLabelPx = 100;
        const minLabelSpan = minLabelPx / xScale;
        const minLabelBytes = 14 / yScaleB;
        for (let idx = 0; idx < n; idx++) {
          const alloc = allocs[visibleBIs ? visibleBIs[idx] : idx];
          if (alloc.size < minLabelBytes) continue;
          let bestX1 = 0, bestY1 = 0, bestW = 0, bestH = 0;
          const off0 = alloc.stripOffset;
          const count = alloc.stripCount;
          const firstTs = buf[off0 * STRIP_FLOATS];
          const lastTe = buf[(off0 + count - 1) * STRIP_FLOATS + 1];
          const vStart = firstTs > tMinN ? firstTs : tMinN;
          const vEnd = lastTe < tMaxN ? lastTe : tMaxN;
          if (vEnd - vStart < minLabelSpan) continue;
          // Binary-search for first strip whose te > tMinN. Strips are
          // time-sorted + contiguous (te_i = ts_{i+1}) per alloc, so this
          // skips the long tail of pre-view strips in O(log n) instead of
          // O(n). Without this, extreme zoom on long-lived allocs spends
          // most of its time linearly walking past strips that ended
          // before the view started.
          let siStart = 0;
          {
            let lo = 0, hi = count;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (buf[(off0 + mid) * STRIP_FLOATS + 1] > tMinN) hi = mid;
              else lo = mid + 1;
            }
            siStart = lo;
          }
          for (let si = siStart; si < count; si++) {
            const off = (off0 + si) * STRIP_FLOATS;
            const ts = buf[off], te = buf[off + 1];
            if (ts >= tMaxN) break;
            if (te <= tMinN) continue;
            const yo = buf[off + 2];
            const xr1 = plotLeftM + (ts - tMinN) * xScale;
            const xr2 = plotLeftM + (te - tMinN) * xScale;
            const x1 = xr1 < plotLeftM ? plotLeftM : xr1;
            const x2 = xr2 > plotRightM ? plotRightM : xr2;
            const sw = x2 - x1;
            if (sw > bestW) {
              bestW = sw; bestX1 = x1;
              bestY1 = plotBotM - (yo + alloc.size - yMin) * yScaleB;
              bestH = alloc.size * yScaleB;
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

        // Pending-free red overlay — same inlined transform + early break.
        const nPending = visibleBIs ? visibleCount : allocs.length;
        for (let idx = 0; idx < nPending; idx++) {
          const alloc = allocs[visibleBIs ? visibleBIs[idx] : idx];
          if (alloc.free_requested_us <= 0) continue;
          if (alloc.size * yScale < 0.5) continue;
          const frqN = alloc.free_requested_us - t0;
          ctx.fillStyle = "rgba(248,113,113,0.38)";
          const off0 = alloc.stripOffset;
          const count = alloc.stripCount;
          // Seek to first strip with te > max(tMinN, frqN) — the overlay
          // only starts at free_requested_us, so anything earlier is dead
          // weight.
          const seekT = tMinN > frqN ? tMinN : frqN;
          let siStartP = 0;
          {
            let lo = 0, hi = count;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (buf[(off0 + mid) * STRIP_FLOATS + 1] > seekT) hi = mid;
              else lo = mid + 1;
            }
            siStartP = lo;
          }
          for (let si = siStartP; si < count; si++) {
            const off = (off0 + si) * STRIP_FLOATS;
            const ts = buf[off], te = buf[off + 1];
            if (ts >= tMaxN) break;
            const os = ts > frqN ? ts : frqN;
            if (os >= te || te <= tMinN || os >= tMaxN) continue;
            const yo = buf[off + 2];
            const xr1 = plotLeftM + (os - tMinN) * xScale;
            const xr2 = plotLeftM + (te - tMinN) * xScale;
            const x1 = xr1 < plotLeftM ? plotLeftM : xr1;
            const x2 = xr2 > plotRightM ? plotRightM : xr2;
            if (x2 - x1 < 0.5) continue;
            ctx.fillRect(
              x1,
              plotBotM - (yo + alloc.size - yMin) * yScaleB,
              x2 - x1,
              alloc.size * yScaleB,
            );
          }
        }
      }

      // Anomaly flags — capped to top N by severity to keep the plot readable
      const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
      for (let ai = 0; ai < flagLimit; ai++) {
        const anomaly = anomalies[ai];
        const vAlloc = usToView(anomaly.alloc_us);
        if (vAlloc > tMax || vAlloc < tMin) continue;
        const x = timeToX(vAlloc);
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

    // Range highlight: hover wins while the cursor is on something,
    // otherwise the clicked (selected) alloc keeps the column visible so
    // the user can see when it lived without hovering. Color is the
    // theme accent (--accent = #d9f99d) throughout for consistency.
    const hoverAlloc = hoverAllocRef.current;
    const hoverAnomaly = hoverAnomalyRef.current;
    const hoverResolved =
      hoverAlloc ||
      (hoverAnomaly ? allocs.find((b) => b.addr === hoverAnomaly.anomaly.addr) ?? null : null);
    const rangeAlloc = hoverResolved ?? selectedAlloc;
    if (rangeAlloc && !selRect) {
      const hb = rangeAlloc;
      {
        const rx1 = Math.max(timeToX(usToView(hb.alloc_us)), MARGIN.left);
        const rx2 = Math.min(timeToX(usToView(hb.free_us)), MARGIN.left + plotW);
        ctx.fillStyle = "rgba(217,249,157,0.08)";
        ctx.fillRect(rx1, MARGIN.top, rx2 - rx1, plotH);
        ctx.strokeStyle = "rgba(217,249,157,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        if (rx1 >= MARGIN.left) { ctx.moveTo(rx1, MARGIN.top); ctx.lineTo(rx1, MARGIN.top + plotH); }
        if (rx2 <= MARGIN.left + plotW) { ctx.moveTo(rx2, MARGIN.top); ctx.lineTo(rx2, MARGIN.top + plotH); }
        ctx.stroke(); ctx.setLineDash([]);
        if (hb.free_requested_us > 0 && hb.free_requested_us < hb.free_us) {
          const px1 = Math.max(timeToX(usToView(hb.free_requested_us)), MARGIN.left);
          const px2 = Math.min(timeToX(usToView(hb.free_us)), MARGIN.left + plotW);
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
      drawRuler(ctx,
        ruler,
        { left: MARGIN.left, top: MARGIN.top, w: plotW, h: plotH },
        xAxisMode, data.time_min, yToBytes, xToTime);
    }

    // Selection rectangle
    if (selRect) {
      drawSelectionRect(ctx, selRect,
        { left: MARGIN.left, top: MARGIN.top, w: plotW, h: plotH });
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
  }, [data, allocs, stripBuffer, anomalies, width, height, timeToX, xToTime, bytesToY, yToBytes, plotW, plotH, selectedAlloc, stripIndex, framePool, maxBytesFull]);


  const hitTest = useCallback(
    (mx: number, my: number): TimelineAlloc | null => {
      if (mx < MARGIN.left || mx > MARGIN.left + plotW) return null;
      if (my < MARGIN.top || my > MARGIN.top + plotH) return null;
      if (!stripBuffer) return null;
      const t = xToTime(mx);
      const mouseBytes = yToBytes(my);
      if (mouseBytes < 0) return null;
      const tN = t - timeOrigin;

      if (stripIndex) {
        const { packed, bw, B } = stripIndex;
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
    [allocs, stripBuffer, timeOrigin, xToTime, yToBytes, plotW, plotH, stripIndex],
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
        const fx = timeToX(usToView(anomaly.alloc_us));
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
  }, [anomalies, timeToX, usToView, hitTest, updateHoverCard]);

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

      // Ctrl/Cmd+C copy trace is handled by <TimelineDetailPanel /> since
      // that component owns the current AllocationDetail.

      // Navigation keys are handled by rAF loop below
      if ("adws".includes(key) || key.startsWith("arrow")) {
        e.preventDefault();
      }
    },
    [],
  );

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    keysDownRef.current.delete(e.key.toLowerCase());
  }, []);

  useNavigation({
    keysDownRef, viewRangeRef, yRangeRef, manualYRangeRef,
    peakBytes: data.peak_bytes,
    timeMin: data.time_min,
    timeMax: data.time_max,
    xAxisMode, totalXRange, invalidate,
  });

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
          // Click → commit whatever hover was already locked on to. The
          // rAF-tracked hoverAllocRef / hoverAnomalyRef is what the user
          // was seeing in the hover card, so selecting the same thing is
          // "what you see is what you pick" — avoids losing thin strips
          // to 1-2 px mousedown drift that a fresh hitTest would catch.
          const anomHover = hoverAnomalyRef.current;
          if (anomHover) {
            // Anomaly flags carry an addr only — resolve the exact
            // alloc via alloc_us from the live list.
            const a = allocs.find((x) => x.addr === anomHover.anomaly.addr);
            setSelectedAlloc(a ? { addr: a.addr, alloc_us: a.alloc_us } : null);
          } else {
            const hit = hoverAllocRef.current ?? hitTest(mx, my);
            setSelectedAlloc(hit ? { addr: hit.addr, alloc_us: hit.alloc_us } : null);
          }
        }
      }
      selStartRef.current = null;
      selRectRef.current = null;
      invalidate();
    },
    [hitTest, anomalies, timeToX, xToTime, yToBytes, plotW, plotH, xAxisMode, setSelectedAlloc, allocs],
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
          className="tl-canvas"
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
            className="eyebrow"
            style={{ letterSpacing: "0.14em", marginBottom: 4 }}
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

      <style>{`
        /* Each canvas keeps tabIndex for keyboard nav, but we hide their
           individual focus rings. The wrapping .tl-frame picks up
           :focus-within and draws a single outline around the two plots
           so they read as one unit. */
        .tl-canvas:focus,
        .tl-canvas:focus-visible { outline: none; }
        .tl-frame {
          position: relative;
          outline: 1px solid transparent;
          outline-offset: 0;
          transition: outline-color 160ms var(--ease, ease);
        }
        .tl-frame:focus-within {
          outline-color: rgba(217,249,157,0.7);
        }

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
        .tl-stack-frame {
          color: var(--fg-dim);
          padding: 1px 0;
        }
        .tl-stack-frame[data-py="1"] { color: var(--fg-muted); }
        .tl-stack-frame[data-py="1"] .tl-stack-loc { color: var(--accent); opacity: 0.8; }
        .tl-stack-name { color: inherit; }
        .tl-stack-loc { color: var(--fg-dim); }
      `}</style>
    </div>
  );
}
