import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineData } from "../types/timeline";
import type { SegmentRow, SegmentAlloc } from "../compute";
import { eventIdxAt } from "../compute/eventTimes";
import { formatBytes, formatTopFrame } from "../utils";
import { initGL, uploadStrips, drawStrips, type GLState } from "./glRenderer";
import { useDataStore } from "../stores/dataStore";

interface Props {
  data: TimelineData;
  rows: SegmentRow[];
  width: number;
  /** Shared with PhaseTimeline so pan/zoom stays in lockstep. */
  viewRangeRef: React.MutableRefObject<[number, number]>;
  /** "time" = μs axis; "event" = alloc/free-event ordinal axis. */
  mode: "time" | "event";
  /** Sorted unique event times (μs relative to data.time_min). Required
   *  in "event" mode; ignored in "time" mode. */
  eventTimes: Float64Array | null;
}

const ROW_H = 30;           // compact row height (all rows by default)
const ROW_H_FOCUSED = 120;  // the row owning the selected alloc expands
const TOP_PAD = 24;         // top margin for axis/labels
const BOTTOM_PAD = 12;
const LEFT_GUTTER = 120;    // room for segment label + size
const RIGHT_PAD = 16;
const MIN_ALLOC_PX = 2;     // every rect paints at least this tall so
                            //  tiny allocs in deep segments stay visible

import {
  COLOR_BG,
  COLOR_DIVIDER,
  COLOR_LABEL,
  COLOR_LABEL_DIM,
  COLOR_PRIVATE,
  COLOR_ACCENT,
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
export default function SegmentTimeline({ data, rows, width, viewRangeRef, mode, eventTimes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GLState | null>(null);
  const dirtyRef = useRef(true);
  const lastViewRef = useRef<[number, number]>([0, 0]);
  const selectedAlloc = useDataStore((s) => s.selectedAlloc);

  const plotLeft = LEFT_GUTTER;
  const plotW = Math.max(50, width - plotLeft - RIGHT_PAD);

  // Locate the selected alloc: which row and which sub-rect in that row.
  // Match on (addr, alloc_us) — addr alone collides under reuse.
  const highlight = useMemo(() => {
    if (!selectedAlloc) return null;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      for (const a of row.allocs) {
        if (a.addr === selectedAlloc.addr && a.alloc_us === selectedAlloc.alloc_us) {
          return { rowIdx: ri, alloc: a, row };
        }
      }
    }
    return null;
  }, [selectedAlloc, rows]);

  // Per-row vertical layout. The selected row (if any) expands so the
  // user can read small allocs inside it; other rows stay compact.
  // Precomputed once per render so hit-test + draw + stripPack share
  // exactly the same Y layout.
  const rowLayout = useMemo(() => {
    const focusedIdx = highlight?.rowIdx ?? -1;
    const yTop = new Float32Array(rows.length);
    const yH = new Float32Array(rows.length);
    let y = TOP_PAD;
    for (let ri = 0; ri < rows.length; ri++) {
      yTop[ri] = y;
      yH[ri] = ri === focusedIdx ? ROW_H_FOCUSED : ROW_H;
      y += yH[ri];
    }
    return { yTop, yH, canvasH: y + BOTTOM_PAD };
  }, [rows, highlight?.rowIdx]);
  const height = rowLayout.canvasH;

  // Build the WebGL instance buffer once per data/size change. Each alloc
  // becomes (t_start, t_end, yBot_in_bytes_axis, h_in_bytes_axis, r, g, b).
  // drawStrips treats y as "bytes pointing up" with origin at canvas
  // bottom; we reuse it by packing pixel-y into that axis.
  const stripPack = useMemo(() => {
    const totalAllocs = rows.reduce((s, r) => s + r.allocs.length, 0);
    const buf = new Float32Array(totalAllocs * 7);
    const tMax = data.time_max;
    const tOrigin = data.time_min;
    const et = eventTimes;
    let w = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const rowYTop = rowLayout.yTop[ri] + 1;
      const rowYBot = rowLayout.yTop[ri] + rowLayout.yH[ri] - 1;
      const rowHPx = rowYBot - rowYTop;
      const inv = 1 / row.totalSize;
      for (const a of row.allocs) {
        const frac = a.size * inv;
        const yTopPx = rowYTop + (a.offsetInSeg * inv) * rowHPx;
        const hPx = Math.max(MIN_ALLOC_PX, frac * rowHPx);
        const yBotPx = yTopPx + hPx;
        const yBotBytes = height - yBotPx;
        const freeUs = a.free_us < 0 ? tMax : a.free_us;
        let x0 = a.alloc_us - tOrigin;
        let x1 = freeUs - tOrigin;
        if (mode === "event" && et) {
          x0 = eventIdxAt(et, x0);
          x1 = eventIdxAt(et, x1);
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
  }, [rows, data.time_min, data.time_max, height, mode, eventTimes, rowLayout]);

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
        const yTop = rowLayout.yTop[ri];
        const rowH = rowLayout.yH[ri];
        const yMid = yTop + rowH / 2;
        // horizontal divider at bottom of row
        ctx.beginPath();
        ctx.moveTo(plotLeft, yTop + rowH);
        ctx.lineTo(width - RIGHT_PAD, yTop + rowH);
        ctx.stroke();

        const isHighlightRow = highlight?.rowIdx === ri;

        // Tint the whole row background when it owns the selection —
        // makes it easy to spot which segment the selected alloc lives in.
        if (isHighlightRow) {
          ctx.fillStyle = "rgba(217,249,157,0.06)";
          ctx.fillRect(plotLeft, yTop + 1, width - RIGHT_PAD - plotLeft, rowH - 1);
        }

        // Label (size) — vertically centered in whatever row height we
        // assigned (compact rows center on yMid; focused rows still center
        // but in a much taller band).
        ctx.textAlign = "right";
        ctx.fillStyle = isHighlightRow ? COLOR_ACCENT : COLOR_LABEL;
        ctx.fillText(formatBytes(row.totalSize), plotLeft - 8, yMid + 4);

        // Segment type badge (private pool, small_pool, large_pool)
        ctx.textAlign = "left";
        const isPrivate = /private|stream/i.test(row.segmentType);
        ctx.fillStyle = isPrivate
          ? COLOR_PRIVATE
          : isHighlightRow
          ? COLOR_LABEL
          : COLOR_LABEL_DIM;
        ctx.fillText(row.segmentType.slice(0, 18), 8, yMid + 4);
      }

      // μs → pixel helper (uses the same scaling drawStrips applies).
      // Accepts raw alloc_us/free_us; handles time vs event mode.
      const [vMin, vMax] = lastViewRef.current;
      const span = vMax - vMin || 1;
      const viewOrigin = mode === "event" ? 0 : data.time_min;
      const vMinN = vMin - viewOrigin;
      const usToPx = (us: number): number => {
        let x = us - data.time_min;
        if (mode === "event" && eventTimes) x = eventIdxAt(eventTimes, x);
        return plotLeft + ((x - vMinN) / span) * plotW;
      };

      // Range highlight: hover > click-selection. Same accent color as
      // PhaseTimeline so one alloc reads identically in both plots.
      const hoveredAlloc = hoverRef.current?.alloc ?? null;
      const rangeAlloc = hoveredAlloc ?? highlight?.alloc ?? null;
      if (rangeAlloc) {
        const freeUs = rangeAlloc.free_us < 0 ? data.time_max : rangeAlloc.free_us;
        const rx1 = Math.max(usToPx(rangeAlloc.alloc_us), plotLeft);
        const rx2 = Math.min(usToPx(freeUs), plotLeft + plotW);
        if (rx2 > rx1) {
          const yTop = TOP_PAD;
          const yBot = height - BOTTOM_PAD;
          ctx.fillStyle = "rgba(217,249,157,0.08)";
          ctx.fillRect(rx1, yTop, rx2 - rx1, yBot - yTop);
          ctx.strokeStyle = "rgba(217,249,157,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath();
          if (rx1 > plotLeft) { ctx.moveTo(rx1, yTop); ctx.lineTo(rx1, yBot); }
          if (rx2 < plotLeft + plotW) { ctx.moveTo(rx2, yTop); ctx.lineTo(rx2, yBot); }
          ctx.stroke(); ctx.setLineDash([]);
        }
      }

      // Selection outline — stroke the rect of the matching alloc.
      if (highlight) {
        const { rowIdx, alloc, row } = highlight;
        const yTop = rowLayout.yTop[rowIdx] + 1;
        const rowHPx = rowLayout.yH[rowIdx] - 2;
        const inv = 1 / row.totalSize;
        const rectYTop = yTop + (alloc.offsetInSeg * inv) * rowHPx;
        const rectH = Math.max(MIN_ALLOC_PX, (alloc.size * inv) * rowHPx);
        const freeUs = alloc.free_us < 0 ? data.time_max : alloc.free_us;
        const cx1 = Math.max(plotLeft, Math.min(plotLeft + plotW, usToPx(alloc.alloc_us)));
        const cx2 = Math.max(plotLeft, Math.min(plotLeft + plotW, usToPx(freeUs)));
        if (cx2 > cx1) {
          ctx.strokeStyle = COLOR_ACCENT;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx1, rectYTop, cx2 - cx1, rectH);
        }
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
  }, [rows, width, height, plotLeft, plotW, data.time_min, data.time_max, viewRangeRef, stripPack.count, mode, eventTimes, highlight]);

  // Mark dirty when selection changes so the outline repaints immediately.
  useEffect(() => { dirtyRef.current = true; }, [highlight]);

  // Click → find which alloc rect the cursor is on, push its addr to the
  // store so the Memory Timeline above highlights it too. Pan/zoom keys
  // stay on PhaseTimeline since it owns keyboard focus.
  const setSelectedAlloc = useDataStore((s) => s.setSelectedAlloc);
  const framePool = useDataStore((s) => s.framePool);
  // Hover lives in both a ref (the draw loop reads it every frame) and
  // React state (the tooltip needs to re-render). The ref is the
  // authoritative value; state mirrors it for the JSX side.
  const hoverRef = useRef<
    | { alloc: SegmentAlloc; row: SegmentRow; mx: number; my: number }
    | null
  >(null);
  const [hover, setHover] = useState<typeof hoverRef.current>(null);

  // Shared hit-test for click + hover. Returns the smallest rect the
  // cursor falls within (with a few pixels of tolerance) plus its row.
  const hitTestAt = (mx: number, my: number) => {
    if (mx < plotLeft) return null;
    // Rows have variable height (focused row expands), so walk the
    // prefix sum instead of dividing by a constant.
    let ri = -1;
    for (let i = 0; i < rows.length; i++) {
      if (my >= rowLayout.yTop[i] && my < rowLayout.yTop[i] + rowLayout.yH[i]) { ri = i; break; }
    }
    if (ri < 0) return null;
    const row = rows[ri];
    const rowYTop = rowLayout.yTop[ri] + 1;
    const rowHPx = rowLayout.yH[ri] - 2;
    const inv = 1 / row.totalSize;

    const [vMin, vMax] = viewRangeRef.current;
    const span = vMax - vMin || 1;
    const timeOrigin = mode === "event" ? 0 : data.time_min;
    const cursorX = vMin + ((mx - plotLeft) / plotW) * span - timeOrigin;
    const tOrigin = data.time_min;

    const xTolUnits = (span / plotW) * 3;
    const yTol = 2;

    let best: { alloc: SegmentAlloc; span: number } | null = null;
    for (const a of row.allocs) {
      const yTopPx = rowYTop + (a.offsetInSeg * inv) * rowHPx;
      const hPx = Math.max(MIN_ALLOC_PX, (a.size * inv) * rowHPx);
      if (my < yTopPx - yTol || my > yTopPx + hPx + yTol) continue;
      const freeUs = a.free_us < 0 ? data.time_max : a.free_us;
      let x0 = a.alloc_us - tOrigin;
      let x1 = freeUs - tOrigin;
      if (mode === "event" && eventTimes) {
        x0 = eventIdxAt(eventTimes, x0);
        x1 = eventIdxAt(eventTimes, x1);
      }
      if (cursorX < x0 - xTolUnits || cursorX > x1 + xTolUnits) continue;
      const allocSpan = x1 - x0;
      if (!best || allocSpan < best.span) best = { alloc: a, span: allocSpan };
    }
    return best ? { alloc: best.alloc, row } : null;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitTestAt(e.clientX - rect.left, e.clientY - rect.top);
    setSelectedAlloc(hit ? { addr: hit.alloc.addr, alloc_us: hit.alloc.alloc_us } : null);
  };

  // Hover tooltip — rerun the same hit-test on move, coalesce via rAF so
  // fast pointer motion doesn't fire O(N_allocs) scans per pixel.
  const hoverPending = useRef<{ mx: number; my: number } | null>(null);
  const hoverRaf = useRef<number | null>(null);
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    hoverPending.current = { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    if (hoverRaf.current !== null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      const p = hoverPending.current;
      hoverPending.current = null;
      if (!p) return;
      const hit = hitTestAt(p.mx, p.my);
      const next = hit ? { alloc: hit.alloc, row: hit.row, mx: p.mx, my: p.my } : null;
      const prev = hoverRef.current;
      hoverRef.current = next;
      dirtyRef.current = true;                // draw loop picks up the overlay
      // Only fire a React update when the hovered alloc changes — avoids
      // re-renders for every pixel of mouse movement over the same rect.
      if (prev?.alloc !== next?.alloc) setHover(next);
    });
  };
  const handleMouseLeave = () => {
    if (hoverRaf.current !== null) {
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = null;
    }
    hoverPending.current = null;
    if (hoverRef.current !== null) {
      hoverRef.current = null;
      dirtyRef.current = true;
      setHover(null);
    }
  };

  return (
    <div style={{ position: "relative", width, height }}>
      <canvas
        ref={glCanvasRef}
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      />
      <canvas
        ref={canvasRef}
        className="tl-canvas"
        style={{ position: "relative", background: "transparent", cursor: "pointer" }}
        tabIndex={0}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {hover && (
        <SegmentHoverCard
          alloc={hover.alloc}
          row={hover.row}
          mx={hover.mx}
          my={hover.my}
          containerW={width}
          framePool={framePool}
          tMax={data.time_max}
        />
      )}
    </div>
  );
}

function SegmentHoverCard({
  alloc,
  row,
  mx,
  my,
  containerW,
  framePool,
  tMax,
}: {
  alloc: SegmentAlloc;
  row: SegmentRow;
  mx: number;
  my: number;
  containerW: number;
  framePool: import("../types/snapshot").FrameRecord[];
  tMax: number;
}) {
  const alive = alloc.free_us < 0;
  const freeUs = alive ? tMax : alloc.free_us;
  const durMs = ((freeUs - alloc.alloc_us) / 1000).toFixed(2);
  const top = formatTopFrame(alloc.top_frame_idx, framePool) || `0x${alloc.addr.toString(16)}`;
  // Place below-right of cursor by default; flip left if it would clip.
  const PAD = 12;
  const CARD_W = 280;
  const left = mx + PAD + CARD_W > containerW ? Math.max(4, mx - PAD - CARD_W) : mx + PAD;
  const top_ = Math.max(4, my + PAD);
  return (
    <div
      className="tl-hover-card mono"
      style={{
        position: "absolute",
        left,
        top: top_,
        width: CARD_W,
        pointerEvents: "none",
        borderLeft: "2px solid var(--accent)",
        display: "block",
      }}
    >
      <div className="faint" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        In segment · 0x{row.segmentAddr.toString(16)}
      </div>
      <div style={{ color: "var(--fg)", fontSize: 14, marginTop: 2 }}>
        {formatBytes(alloc.size)}
        <span className="faint" style={{ marginLeft: 6, fontSize: 11 }}>
          +{formatBytes(alloc.offsetInSeg)} / {formatBytes(row.totalSize)}
        </span>
      </div>
      <div style={{ color: "var(--fg-muted)", fontSize: 11, marginTop: 2 }}>{top}</div>
      <div className="faint" style={{ fontSize: 10, marginTop: 2 }}>
        {alive ? `${durMs}ms · alive` : `${durMs}ms`}
      </div>
    </div>
  );
}
