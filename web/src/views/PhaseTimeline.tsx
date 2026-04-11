import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type {
  TimelineData,
  TimelineBlock,
  AllocationDetail,
} from "../types/timeline";
import { formatBytes } from "../utils";
import { useDataStore } from "../stores/dataStore";
import { initGL, uploadStrips, drawStrips, type GLState } from "./glRenderer";

import type { Anomaly } from "../compute";

interface Props {
  data: TimelineData;
  blocks: TimelineBlock[];
  anomalies: Anomaly[];
  width: number;
  height: number;
  currentRank: number;
}

const ANOMALY_COLORS: Record<string, string> = {
  pending_free: "#f87171",
  leak: "#fbbf24",
};
const FLAG_SIZE = 8;
// Cap flags drawn on the timeline to avoid visual overload.
// The panel still shows all anomalies. Sorted by severity, so we keep the worst.
const TIMELINE_FLAG_LIMIT = 40;

// Visual tokens — mirror theme.css for canvas drawing
const COLOR_BG = "#0a0a0b";
const COLOR_GRID = "#17171a";
const COLOR_AXIS = "#52525b";
const COLOR_AXIS_DIM = "#3f3f46";
const COLOR_ACCENT = "#d9f99d";
const COLOR_PEAK = "#f87171";
const FONT_MONO = '11px "JetBrains Mono", ui-monospace, monospace';
const FONT_MONO_SM = '10px "JetBrains Mono", ui-monospace, monospace';
const FONT_DISPLAY_SM = '10px "Space Grotesk", sans-serif';

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
  blocks,
  anomalies,
  width,
  height,
  currentRank,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);   // 2D overlay
  const glCanvasRef = useRef<HTMLCanvasElement>(null);  // WebGL strips
  const glRef = useRef<GLState | null>(null);
  const stripKeyRef = useRef("");
  const [viewRange, setViewRange] = useState<[number, number]>([
    data.time_min,
    data.time_max,
  ]);
  const [selectedBlock, setSelectedBlock] = useState<TimelineBlock | null>(null);
  const [detail, setDetail] = useState<AllocationDetail | null>(null);
  const [hoverBlock, setHoverBlock] = useState<TimelineBlock | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [selRect, setSelRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const selStartRef = useRef<{ x: number; y: number } | null>(null);

  // Anomaly focus from store — smooth animated transition
  const focusedAddr = useDataStore((s) => s.focusedAddr);
  const focusRange = useDataStore((s) => s.focusRange);
  const animRef = useRef<number>(0);

  useEffect(() => {
    if (!focusRange) return;
    cancelAnimationFrame(animRef.current);
    const from: [number, number] = [...viewRange];
    const to = focusRange;
    const start = performance.now();
    const duration = 350;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const ease = t * (2 - t); // ease-out quad
      setViewRange([from[0] + (to[0] - from[0]) * ease, from[1] + (to[1] - from[1]) * ease]);
      if (t < 1) animRef.current = requestAnimationFrame(tick);
    }
    animRef.current = requestAnimationFrame(tick);
    canvasRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => cancelAnimationFrame(animRef.current);
  }, [focusRange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (focusedAddr !== null) {
      const block = blocks.find((b) => b.addr === focusedAddr) ?? null;
      setSelectedBlock(block);
      if (block) {
        const d = useDataStore.getState().getDetail(currentRank, block.addr);
        setDetail(d);
      }
    }
  }, [focusedAddr, blocks, currentRank]);

  // Ruler state
  const [ruler, setRuler] = useState<Ruler | null>(null);
  const rulerDragRef = useRef<{ type: RulerType; startPx: { x: number; y: number } } | null>(null);
  const keysDownRef = useRef<Set<string>>(new Set());

  // Anomaly flag hover
  const [hoverAnomaly, setHoverAnomaly] = useState<{ anomaly: Anomaly; x: number; y: number } | null>(null);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const maxBytesFull = useDataStore((s) => s.timelineMaxBytesFull);

  const maxBytes = useMemo(() => {
    const [tMin, tMax] = viewRange;
    // Fast path: full view — use pre-computed per-rank max, skip 30k iterations
    if (tMin <= data.time_min && tMax >= data.time_max && maxBytesFull > 0) {
      return maxBytesFull;
    }
    let maxB = 0;
    for (const block of blocks) {
      for (const strip of block.strips) {
        if (strip.t_end <= tMin || strip.t_start >= tMax) continue;
        const top = strip.y_offset + block.size;
        if (top > maxB) maxB = top;
      }
    }
    return (maxB || data.peak_bytes) * 1.1;
  }, [viewRange, blocks, data.peak_bytes, data.time_min, data.time_max, maxBytesFull]);

  useEffect(() => {
    setViewRange([data.time_min, data.time_max]);
    setSelectedBlock(null);
    setDetail(null);
    setRuler(null);
  }, [data.time_min, data.time_max]);

  const timeToX = useCallback(
    (t: number) => MARGIN.left + ((t - viewRange[0]) / (viewRange[1] - viewRange[0])) * plotW,
    [viewRange, plotW],
  );
  const xToTime = useCallback(
    (x: number) => viewRange[0] + ((x - MARGIN.left) / plotW) * (viewRange[1] - viewRange[0]),
    [viewRange, plotW],
  );
  const bytesToY = useCallback(
    (b: number) => MARGIN.top + plotH - (b / maxBytes) * plotH,
    [maxBytes, plotH],
  );
  const yToBytes = useCallback(
    (y: number) => ((MARGIN.top + plotH - y) / plotH) * maxBytes,
    [maxBytes, plotH],
  );

  // --- WebGL strip upload (zero-copy from pre-packed buffer) ---
  const stripBuffer = useDataStore((s) => s.timelineStripBuffer);
  const stripCount = useDataStore((s) => s.timelineStripCount);
  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas || !stripBuffer) return;
    if (!glRef.current) glRef.current = initGL(glCanvas);
    if (!glRef.current) return;
    const key = `${currentRank}-${stripCount}`;
    if (key !== stripKeyRef.current) {
      uploadStrips(glRef.current, stripBuffer, stripCount);
      stripKeyRef.current = key;
    }
  }, [stripBuffer, stripCount, currentRank]);

  // --- Render: WebGL strips + 2D overlay ---
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

    const [tMin, tMax] = viewRange;

      // WebGL: draw strips (one draw call, GPU-accelerated)
      if (glRef.current) {
        drawStrips(glRef.current, width, height, MARGIN.left, MARGIN.top, plotW, plotH, tMin, tMax, maxBytes, data.time_min);
      }

      // 2D overlay canvas: clear transparent, then fill margins opaque
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, width, MARGIN.top);
      ctx.fillRect(0, MARGIN.top + plotH, width, height - MARGIN.top - plotH);
      ctx.fillRect(0, MARGIN.top, MARGIN.left, plotH);
      ctx.fillRect(MARGIN.left + plotW, MARGIN.top, MARGIN.right, plotH);

      const yScale = plotH / maxBytes;

      // Selection highlight
      if (selectedBlock) {
        ctx.strokeStyle = COLOR_ACCENT;
        ctx.lineWidth = 2;
        for (const strip of selectedBlock.strips) {
          if (strip.t_end <= tMin || strip.t_start >= tMax) continue;
          const x1 = Math.max(timeToX(strip.t_start), MARGIN.left);
          const x2 = Math.min(timeToX(strip.t_end), MARGIN.left + plotW);
          if (x2 - x1 < 0.3) continue;
          const y1 = bytesToY(strip.y_offset + selectedBlock.size);
          const y2 = bytesToY(strip.y_offset);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        }
      }

      // Block labels
      ctx.globalAlpha = 0.92;
      ctx.font = FONT_MONO_SM;
      for (const block of blocks) {
        let bestX1 = 0, bestY1 = 0, bestW = 0, bestH = 0;
        for (const strip of block.strips) {
          if (strip.t_end <= tMin || strip.t_start >= tMax) continue;
          const x1 = Math.max(timeToX(strip.t_start), MARGIN.left);
          const sw = Math.min(timeToX(strip.t_end), MARGIN.left + plotW) - x1;
          if (sw > bestW) {
            bestW = sw; bestX1 = x1;
            bestY1 = bytesToY(strip.y_offset + block.size);
            bestH = bytesToY(strip.y_offset) - bestY1;
          }
        }
        if (bestW < 100 || bestH < 14) continue;
        const label = block.top_frame || `0x${block.addr.toString(16)}`;
        const maxChars = Math.floor(bestW / 6.5);
        const text = label.length > maxChars ? label.slice(0, maxChars - 1) + "\u2026" : label;
        ctx.fillStyle = "rgba(250,250,250,0.95)";
        ctx.fillText(text, bestX1 + 4, bestY1 + 12);
        if (bestH > 26) { ctx.fillStyle = "rgba(250,250,250,0.55)"; ctx.fillText(formatBytes(block.size), bestX1 + 4, bestY1 + 24); }
      }
      ctx.globalAlpha = 1;

      // Pending-free red overlay
      for (const block of blocks) {
        if (block.free_requested_us <= 0) continue;
        if (block.size * yScale < 0.5) continue;
        ctx.fillStyle = "rgba(248,113,113,0.38)";
        for (const strip of block.strips) {
          const os = Math.max(strip.t_start, block.free_requested_us);
          if (os >= strip.t_end || strip.t_end <= tMin || os >= tMax) continue;
          const x1 = Math.max(timeToX(os), MARGIN.left);
          const x2 = Math.min(timeToX(strip.t_end), MARGIN.left + plotW);
          if (x2 - x1 < 0.5) continue;
          ctx.fillRect(x1, bytesToY(strip.y_offset + block.size), x2 - x1, bytesToY(strip.y_offset) - bytesToY(strip.y_offset + block.size));
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
        const b = (maxBytes / 5) * i, y = bytesToY(b);
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
        ctx.fillText(`${((t - data.time_min) / 1e6).toFixed(2)}s`, tx, height - 14);
      }
      // X axis label
      ctx.textAlign = "right";
      ctx.fillStyle = COLOR_AXIS_DIM;
      ctx.font = FONT_DISPLAY_SM;
      ctx.fillText("TIME →", MARGIN.left + plotW, height - 2);

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
    if ((hoverBlock || hoverAnomaly) && !selRect) {
      const hb = hoverBlock || blocks.find((b) => b.addr === hoverAnomaly?.anomaly.addr);
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
        drawPill(ctx, formatTime(tL - data.time_min), xL, y - 16); drawPill(ctx, formatTime(tR - data.time_min), xR, y - 16);
        drawPill(ctx, `\u0394 ${formatTime(delta)}`, (xL + xR) / 2, y + 16);
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
  }, [data, blocks, anomalies, viewRange, width, height, timeToX, xToTime, bytesToY, yToBytes, maxBytes, plotW, plotH, selectedBlock, hoverBlock, hoverAnomaly, ruler, selRect]);

  // hit test
  const hitTest = useCallback(
    (mx: number, my: number): TimelineBlock | null => {
      if (mx < MARGIN.left || mx > MARGIN.left + plotW) return null;
      if (my < MARGIN.top || my > MARGIN.top + plotH) return null;
      const t = xToTime(mx);
      const mouseBytes = yToBytes(my);
      if (mouseBytes < 0) return null;
      for (let bi = blocks.length - 1; bi >= 0; bi--) {
        const block = blocks[bi];
        for (const strip of block.strips) {
          if (t < strip.t_start || t >= strip.t_end) continue;
          if (mouseBytes >= strip.y_offset && mouseBytes < strip.y_offset + block.size) {
            return block;
          }
          break;
        }
      }
      return null;
    },
    [blocks, xToTime, yToBytes, plotW, plotH],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Ruler dragging — clamp to plot area
      if (rulerDragRef.current) {
        const { type, startPx } = rulerDragRef.current;
        const cy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
        const cx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
        const endPx = type === "vertical" ? { x: startPx.x, y: cy } : { x: cx, y: startPx.y };
        setRuler({ type, startPx, endPx });
        return;
      }

      // Selection rectangle dragging
      if (selStartRef.current) {
        const cx = Math.max(MARGIN.left, Math.min(MARGIN.left + plotW, mx));
        const cy = Math.max(MARGIN.top, Math.min(MARGIN.top + plotH, my));
        setSelRect({ x1: selStartRef.current.x, y1: selStartRef.current.y, x2: cx, y2: cy });
        return;
      }

      // Check flag hit (top margin area) — only visible flags
      if (my < MARGIN.top && my >= MARGIN.top - FLAG_SIZE - 2) {
        const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
        for (let ai = 0; ai < flagLimit; ai++) {
          const anomaly = anomalies[ai];
          const fx = timeToX(anomaly.alloc_us);
          if (Math.abs(mx - fx) < FLAG_SIZE) {
            setHoverAnomaly({ anomaly, x: mx, y: my });
            setHoverBlock(null);
            setHoverPos(null);
            return;
          }
        }
      }
      setHoverAnomaly(null);

      const hit = hitTest(mx, my);
      setHoverBlock(hit);
      setHoverPos(hit ? { x: mx, y: my } : null);
    },
    [hitTest, data, plotW, plotH, anomalies, timeToX],
  );


  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keysDownRef.current.add(key);

      // Escape dismisses ruler
      if (key === "escape") {
        setRuler(null);
        rulerDragRef.current = null;
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

  // Continuous smooth navigation via rAF while WASD/arrows are held
  const navRafRef = useRef<number>(0);
  const viewRangeRef = useRef(viewRange);
  viewRangeRef.current = viewRange;

  useEffect(() => {
    let running = true;
    function tick() {
      if (!running) return;
      const keys = keysDownRef.current;
      const hasNav = keys.has("a") || keys.has("d") || keys.has("w") || keys.has("s")
        || keys.has("arrowleft") || keys.has("arrowright") || keys.has("arrowup") || keys.has("arrowdown");
      if (hasNav) {
        const [tMin, tMax] = viewRangeRef.current;
        const range = tMax - tMin;
        const fullRange = data.time_max - data.time_min;
        const panRate = range * 0.02; // 2% per frame (~60fps = smooth scroll)
        const zoomRate = 0.97; // zoom in 3% per frame
        let newMin = tMin, newMax = tMax;

        if (keys.has("a") || keys.has("arrowleft")) {
          newMin = Math.max(data.time_min, tMin - panRate);
          newMax = newMin + range;
        }
        if (keys.has("d") || keys.has("arrowright")) {
          newMax = Math.min(data.time_max, tMax + panRate);
          newMin = newMax - range;
        }
        if (keys.has("w") || keys.has("arrowup")) {
          const nr = range * zoomRate;
          if (nr > 100) { // minimum 100us visible range
            const c = (newMin + newMax) / 2;
            newMin = Math.max(data.time_min, c - nr / 2);
            newMax = Math.min(data.time_max, newMin + nr);
          }
        }
        if (keys.has("s") || keys.has("arrowdown")) {
          const nr = Math.min(fullRange, range / zoomRate);
          const c = (newMin + newMax) / 2;
          newMin = Math.max(data.time_min, c - nr / 2);
          newMax = Math.min(data.time_max, newMin + nr);
        }

        if (newMin !== tMin || newMax !== tMax) {
          setViewRange([newMin, newMax]);
        }
      }
      navRafRef.current = requestAnimationFrame(tick);
    }
    navRafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(navRafRef.current); };
  }, [data.time_min, data.time_max]);

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
    [],
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
          // Selection rectangle → zoom into region
          const cx1 = Math.max(MARGIN.left, Math.min(selStartRef.current.x, mx));
          const cx2 = Math.min(MARGIN.left + plotW, Math.max(selStartRef.current.x, mx));
          const newTMin = xToTime(cx1);
          const newTMax = xToTime(cx2);
          if (newTMax - newTMin > 100) {
            setViewRange([newTMin, newTMax]);
          }
        } else {
          // Click — flag or block selection
          if (my < MARGIN.top && my >= MARGIN.top - FLAG_SIZE - 2) {
            const flagLimit = Math.min(anomalies.length, TIMELINE_FLAG_LIMIT);
            for (let ai = 0; ai < flagLimit; ai++) {
              const anomaly = anomalies[ai];
              const fx = timeToX(anomaly.alloc_us);
              if (Math.abs(mx - fx) < FLAG_SIZE) {
                const block = blocks.find((b) => b.addr === anomaly.addr) ?? null;
                setSelectedBlock(block);
                setDetail(null);
                if (block) {
                  const d = useDataStore.getState().getDetail(currentRank, block.addr);
                  if (d) setDetail(d);
                }
                selStartRef.current = null;
                setSelRect(null);
                return;
              }
            }
          }
          const hit = hitTest(mx, my);
          setSelectedBlock(hit);
          setDetail(null);
          if (hit) {
            const d = useDataStore.getState().getDetail(currentRank, hit.addr);
            if (d) setDetail(d);
          }
        }
      }
      selStartRef.current = null;
      setSelRect(null);
    },
    [hitTest, currentRank, anomalies, blocks, timeToX],
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
            setHoverBlock(null);
            setHoverPos(null);
            setHoverAnomaly(null);
            selStartRef.current = null;
            setSelRect(null);
            if (rulerDragRef.current) rulerDragRef.current = null;
          }}
          onDoubleClick={() => setViewRange([data.time_min, data.time_max])}
        />
        {/* anomaly flag tooltip */}
        {hoverAnomaly && (
          <div
            className="tl-tooltip"
            style={{
              left: Math.min(hoverAnomaly.x + 12, width - 320),
              top: Math.max(hoverAnomaly.y + 8, 4),
              borderLeft: `2px solid ${ANOMALY_COLORS[hoverAnomaly.anomaly.type]}`,
            }}
          >
            <div
              className="display"
              style={{
                color: ANOMALY_COLORS[hoverAnomaly.anomaly.type],
                fontSize: 10,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                marginBottom: 4,
              }}
            >
              {hoverAnomaly.anomaly.type === "pending_free" ? "Pending Free" : "Leak Suspect"}
            </div>
            <div className="mono" style={{ color: "var(--fg)", marginBottom: 2 }}>
              {formatBytes(hoverAnomaly.anomaly.size)} · {hoverAnomaly.anomaly.label}
            </div>
            <div className="mono faint" style={{ fontSize: 10 }}>
              {hoverAnomaly.anomaly.top_frame}
            </div>
          </div>
        )}
        {/* hover tooltip */}
        {hoverBlock && hoverPos && !hoverAnomaly && (
          <div
            className="tl-tooltip"
            style={{
              left: Math.min(hoverPos.x + 12, width - 320),
              top: Math.max(hoverPos.y - 70, 4),
            }}
          >
            <div className="mono" style={{ color: "var(--fg)", fontSize: 13, marginBottom: 2 }}>
              {formatBytes(hoverBlock.size)}
            </div>
            <div className="mono" style={{ color: "var(--fg-muted)", fontSize: 11, marginBottom: 2 }}>
              {hoverBlock.top_frame || `0x${hoverBlock.addr.toString(16)}`}
            </div>
            <div className="mono faint" style={{ fontSize: 10 }}>
              {((hoverBlock.free_us - hoverBlock.alloc_us) / 1e6).toFixed(4)}s
              {hoverBlock.alive && " · alive"}
            </div>
          </div>
        )}
        <div className="tl-hint mono">
          <span>WASD</span> navigate · <span>W/S</span> zoom · <span>R+drag</span> mem ruler · <span>T+drag</span> time ruler · <span>Esc</span> clear · <span>⌘C</span> copy
        </div>
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
        .tl-hint {
          position: absolute;
          bottom: 52px;
          right: 28px;
          font-size: 10px;
          color: var(--fg-dim);
          letter-spacing: 0.04em;
        }
        .tl-hint span {
          color: var(--fg-faint);
          font-weight: 500;
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
