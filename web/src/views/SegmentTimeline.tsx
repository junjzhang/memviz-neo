import { useEffect, useMemo, useRef } from "react";
import type { TimelineData } from "../types/timeline";
import type { SegmentRow } from "../compute";
import { formatBytes } from "../utils";
import { initGL, uploadStrips, drawStrips, type GLState } from "./glRenderer";

interface Props {
  data: TimelineData;
  rows: SegmentRow[];
  width: number;
  height: number;
  /** Shared with PhaseTimeline so pan/zoom stays in lockstep. */
  viewRangeRef: React.MutableRefObject<[number, number]>;
  /** "time" = μs axis; "event" = alloc/free-event ordinal axis. */
  mode: "time" | "event";
  /** Sorted unique event times (μs relative to data.time_min). Required
   *  in "event" mode; ignored in "time" mode. */
  eventTimes: Float64Array | null;
}

const ROW_H = 26;           // height per segment row in CSS px
const TOP_PAD = 24;         // top margin for axis/labels
const BOTTOM_PAD = 12;
const LEFT_GUTTER = 120;    // room for segment label + size
const RIGHT_PAD = 16;

import {
  COLOR_BG,
  COLOR_DIVIDER,
  COLOR_LABEL,
  COLOR_LABEL_DIM,
  COLOR_PRIVATE,
  FONT_MONO_SM as FONT_MONO,
} from "./theme";

/**
 * Allocator-segment timeline. Rows = cached segments (large cached
 * regions PyTorch asked from CUDA). Within a row, Y is offset inside
 * that segment (0..totalSize), X is time. Each alloc rect shows when a
 * specific address range was in use. Lets you watch fragmentation and
 * long-lived allocations pin a segment open across iterations.
 *
 * Time axis is read from `viewRangeRef` which is shared with
 * PhaseTimeline — panning / zooming either view moves both.
 */
export default function SegmentTimeline({ data, rows, width, height, viewRangeRef, mode, eventTimes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GLState | null>(null);
  const dirtyRef = useRef(true);
  const lastViewRef = useRef<[number, number]>([0, 0]);

  const plotLeft = LEFT_GUTTER;
  const plotW = Math.max(50, width - plotLeft - RIGHT_PAD);

  // Build the WebGL instance buffer once per data/size change. Each alloc
  // becomes (t_start, t_end, yBot_in_bytes_axis, h_in_bytes_axis, r, g, b).
  // drawStrips treats y as "bytes pointing up" with origin at canvas
  // bottom; we reuse it by packing pixel-y into that axis.
  const stripPack = useMemo(() => {
    const totalAllocs = rows.reduce((s, r) => s + r.allocs.length, 0);
    const buf = new Float32Array(totalAllocs * 7);
    const tMax = data.time_max;
    const tOrigin = data.time_min;
    // Reused binary search for event-mode X mapping.
    const et = eventTimes;
    const eventIdx = (tUsNorm: number): number => {
      if (!et) return 0;
      let lo = 0, hi = et.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (et[mid] < tUsNorm) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let w = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const rowYTop = TOP_PAD + ri * ROW_H + 1;
      const rowYBot = TOP_PAD + (ri + 1) * ROW_H - 1;
      const rowHPx = rowYBot - rowYTop;
      const inv = 1 / row.totalSize;
      for (const a of row.allocs) {
        const frac = a.size * inv;
        const yTopPx = rowYTop + (a.offsetInSeg * inv) * rowHPx;
        const hPx = Math.max(1, frac * rowHPx);
        const yBotPx = yTopPx + hPx;
        const yBotBytes = height - yBotPx;
        const freeUs = a.free_us < 0 ? tMax : a.free_us;
        let x0 = a.alloc_us - tOrigin;
        let x1 = freeUs - tOrigin;
        if (mode === "event" && et) {
          x0 = eventIdx(x0);
          x1 = eventIdx(x1);
        }
        buf[w * 7]     = x0;
        buf[w * 7 + 1] = x1;
        buf[w * 7 + 2] = yBotBytes;
        buf[w * 7 + 3] = hPx;
        buf[w * 7 + 4] = a.color[0];
        buf[w * 7 + 5] = a.color[1];
        buf[w * 7 + 6] = a.color[2];
        w++;
      }
    }
    return { buf, count: w };
  }, [rows, data.time_min, data.time_max, height, mode, eventTimes]);

  // Upload to GPU whenever pack changes.
  useEffect(() => {
    if (!glCanvasRef.current) return;
    if (!glRef.current) glRef.current = initGL(glCanvasRef.current);
    if (!glRef.current) return;
    uploadStrips(glRef.current, stripPack.buf, stripPack.count);
    dirtyRef.current = true;
  }, [stripPack]);

  // Render loop. Polls the shared viewRangeRef every frame so pans in
  // PhaseTimeline pull us along without an explicit event bus.
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
      const vr = viewRangeRef.current;
      if (vr[0] !== lastViewRef.current[0] || vr[1] !== lastViewRef.current[1]) {
        dirtyRef.current = true;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      lastViewRef.current = [vr[0], vr[1]];

      // WebGL strip pass. We pass y range = [0, height] so the y axis
      // spans the whole canvas in pixel units, matching how stripPack
      // encoded y.
      if (glRef.current && stripPack.count > 0) {
        // In event mode the packed x values are already 0-based event
        // indices; in time mode they were packed as (t - time_min). The
        // timeOrigin we pass to drawStrips must match the packing so
        // shader normalization lines up.
        const timeOrigin = mode === "event" ? 0 : data.time_min;
        drawStrips(
          glRef.current,
          width, height,
          plotLeft, 0, plotW, height,
          vr[0], vr[1],
          0, height,             // y range in px
          timeOrigin,
        );
      }

      // ---- 2D overlay: gutter, row dividers, labels ----
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, plotLeft, height);
      ctx.fillRect(0, 0, width, TOP_PAD);
      ctx.fillRect(0, height - BOTTOM_PAD, width, BOTTOM_PAD);

      // Column header
      ctx.font = FONT_MONO;
      ctx.fillStyle = COLOR_LABEL_DIM;
      ctx.textAlign = "right";
      ctx.fillText("SEGMENT", plotLeft - 8, 14);

      // Row dividers + labels
      ctx.strokeStyle = COLOR_DIVIDER;
      ctx.lineWidth = 1;
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const yTop = TOP_PAD + ri * ROW_H;
        const yMid = yTop + ROW_H / 2;
        // horizontal divider at bottom of row
        ctx.beginPath();
        ctx.moveTo(plotLeft, yTop + ROW_H);
        ctx.lineTo(width - RIGHT_PAD, yTop + ROW_H);
        ctx.stroke();

        // Label (size)
        ctx.textAlign = "right";
        ctx.fillStyle = COLOR_LABEL;
        ctx.fillText(formatBytes(row.totalSize), plotLeft - 8, yMid + 4);

        // Segment type badge (private pool, small_pool, large_pool)
        ctx.textAlign = "left";
        const isPrivate = /private|stream/i.test(row.segmentType);
        ctx.fillStyle = isPrivate ? COLOR_PRIVATE : COLOR_LABEL_DIM;
        ctx.fillText(row.segmentType.slice(0, 18), 8, yMid + 4);
      }

      // Left divider line between gutter and plot
      ctx.strokeStyle = COLOR_DIVIDER;
      ctx.beginPath();
      ctx.moveTo(plotLeft, TOP_PAD);
      ctx.lineTo(plotLeft, height - BOTTOM_PAD);
      ctx.stroke();
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [rows, width, height, plotLeft, plotW, data.time_min, viewRangeRef, stripPack.count, mode]);

  // No mouse handlers here — pan/zoom is driven via WASD on the Memory
  // Timeline above; this view reads the shared viewRangeRef and follows
  // automatically every frame.
  return (
    <div style={{ position: "relative", width, height }}>
      <canvas
        ref={glCanvasRef}
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      />
      <canvas
        ref={canvasRef}
        style={{ position: "relative", background: "transparent" }}
      />
    </div>
  );
}
