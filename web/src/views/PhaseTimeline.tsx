import { useRef, useEffect, useState, useCallback } from "react";
import type {
  TimelineData,
  TimelineAnnotation,
  TimelineBlock,
  AllocationDetail,
} from "../types/timeline";
import { formatBytes } from "../utils";

interface Props {
  data: TimelineData;
  blocks: TimelineBlock[];
  width: number;
  height: number;
  currentRank: number;
}

const MARGIN = { top: 20, right: 20, bottom: 40, left: 80 };

const BLOCK_PALETTE = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
  "#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#6366f1",
  "#84cc16", "#e879f9", "#0ea5e9", "#fb923c", "#a78bfa",
];

const PHASE_COLORS: Record<string, string> = {
  "FSDP::all_gather": "rgba(59,130,246,0.10)",
  "FSDP::reduce_scatter": "rgba(239,68,68,0.10)",
  "Optimizer.step": "rgba(34,197,94,0.10)",
};

function getPhaseColor(name: string): string | null {
  for (const [prefix, color] of Object.entries(PHASE_COLORS)) {
    if (name.startsWith(prefix)) return color;
  }
  return null;
}

export default function PhaseTimeline({
  data,
  blocks,
  width,
  height,
  currentRank,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewRange, setViewRange] = useState<[number, number]>([
    data.time_min,
    data.time_max,
  ]);
  const [selectedBlock, setSelectedBlock] = useState<TimelineBlock | null>(null);
  const [detail, setDetail] = useState<AllocationDetail | null>(null);
  const [hoverBlock, setHoverBlock] = useState<TimelineBlock | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; range: [number, number] } | null>(null);
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const maxBytes = data.peak_bytes * 1.1;

  useEffect(() => {
    setViewRange([data.time_min, data.time_max]);
    setSelectedBlock(null);
    setDetail(null);
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

  // draw
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
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, height);

    const [tMin, tMax] = viewRange;

    // annotation phase bands
    const paired = pairAnnotations(data.annotations);
    for (const { name, start, end } of paired) {
      if (end < tMin || start > tMax) continue;
      const color = getPhaseColor(name);
      if (!color) continue;
      const x1 = Math.max(timeToX(start), MARGIN.left);
      const x2 = Math.min(timeToX(end), MARGIN.left + plotW);
      if (x2 - x1 < 0.3) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x1, MARGIN.top, x2 - x1, plotH);
    }

    // Draw polygon strips — each strip is a rectangle at constant y_offset
    for (const block of blocks) {
      ctx.fillStyle = BLOCK_PALETTE[block.idx % BLOCK_PALETTE.length];
      for (const strip of block.strips) {
        if (strip.t_end <= tMin || strip.t_start >= tMax) continue;
        const x1 = Math.max(timeToX(strip.t_start), MARGIN.left);
        const x2 = Math.min(timeToX(strip.t_end), MARGIN.left + plotW);
        const sw = x2 - x1;
        if (sw < 0.3) continue;
        const y1 = bytesToY(strip.y_offset + block.size);
        const y2 = bytesToY(strip.y_offset);
        const sh = y2 - y1;
        if (sh < 0.3) continue;
        ctx.fillRect(x1, y1, sw, sh);
      }
    }

    // Draw block labels on the longest visible strip
    ctx.globalAlpha = 0.9;
    ctx.font = "10px monospace";
    for (const block of blocks) {
      let bestX1 = 0, bestX2 = 0, bestY1 = 0, bestY2 = 0, bestW = 0;
      for (const strip of block.strips) {
        if (strip.t_end <= tMin || strip.t_start >= tMax) continue;
        const x1 = Math.max(timeToX(strip.t_start), MARGIN.left);
        const x2 = Math.min(timeToX(strip.t_end), MARGIN.left + plotW);
        const sw = x2 - x1;
        if (sw > bestW) {
          bestW = sw;
          bestX1 = x1;
          bestX2 = x2;
          bestY1 = bytesToY(strip.y_offset + block.size);
          bestY2 = bytesToY(strip.y_offset);
        }
      }
      if (bestW < 100) continue;
      const bh = bestY2 - bestY1;
      if (bh < 14) continue;

      const label = block.top_frame || `0x${block.addr.toString(16)}`;
      const maxChars = Math.floor(bestW / 6.5);
      const text = label.length > maxChars ? label.slice(0, maxChars - 1) + "\u2026" : label;
      ctx.fillStyle = "#fff";
      ctx.fillText(text, bestX1 + 3, bestY1 + 11);
      if (bh > 26) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText(formatBytes(block.size), bestX1 + 3, bestY1 + 23);
      }

      // selection border
      if (selectedBlock?.addr === block.addr) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(bestX1, bestY1, bestX2 - bestX1, bh);
      }
    }
    ctx.globalAlpha = 1;

    // Y axis
    ctx.fillStyle = "#666";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const b = (maxBytes / yTicks) * i;
      const y = bytesToY(b);
      ctx.fillText(formatBytes(b), MARGIN.left - 8, y + 4);
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(MARGIN.left + plotW, y);
      ctx.stroke();
    }

    // X axis
    ctx.textAlign = "center";
    ctx.fillStyle = "#666";
    const duration = tMax - tMin;
    const xTicks = Math.min(8, Math.floor(plotW / 100));
    for (let i = 0; i <= xTicks; i++) {
      const t = tMin + (duration / xTicks) * i;
      const x = timeToX(t);
      const relSec = (t - data.time_min) / 1e6;
      ctx.fillText(`${relSec.toFixed(2)}s`, x, height - 8);
    }

    // peak line
    const peakY = bytesToY(data.peak_bytes);
    ctx.strokeStyle = "rgba(239,68,68,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, peakY);
    ctx.lineTo(MARGIN.left + plotW, peakY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "left";
    ctx.font = "10px monospace";
    ctx.fillText(`peak: ${formatBytes(data.peak_bytes)}`, MARGIN.left + 4, peakY - 4);

    // border
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN.left, MARGIN.top, plotW, plotH);
  }, [data, blocks, viewRange, width, height, timeToX, bytesToY, maxBytes, plotW, plotH, selectedBlock]);

  // hit test: find block whose strip contains the mouse point
  const hitTest = useCallback(
    (mx: number, my: number): TimelineBlock | null => {
      if (mx < MARGIN.left || mx > MARGIN.left + plotW) return null;
      if (my < MARGIN.top || my > MARGIN.top + plotH) return null;

      const t = xToTime(mx);
      const mouseBytes = yToBytes(my);
      if (mouseBytes < 0) return null;

      // Iterate in reverse (higher idx = smaller = drawn on top) for correct z-order
      for (let bi = blocks.length - 1; bi >= 0; bi--) {
        const block = blocks[bi];
        for (const strip of block.strips) {
          if (t < strip.t_start || t >= strip.t_end) continue;
          if (mouseBytes >= strip.y_offset && mouseBytes < strip.y_offset + block.size) {
            return block;
          }
          break; // only one strip active per block at any time
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

      if (isPanning && panStartRef.current) {
        const dx = mx - panStartRef.current.x;
        const [rMin, rMax] = panStartRef.current.range;
        const tPerPx = (rMax - rMin) / plotW;
        const dt = -dx * tPerPx;
        const newMin = Math.max(data.time_min, rMin + dt);
        const newMax = Math.min(data.time_max, rMax + dt);
        if (newMax - newMin > 1000) setViewRange([newMin, newMax]);
        return;
      }

      const hit = hitTest(mx, my);
      setHoverBlock(hit);
      setHoverPos(hit ? { x: mx, y: my } : null);
    },
    [isPanning, hitTest, data, plotW],
  );


  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, (mx - MARGIN.left) / plotW));
      const [tMin, tMax] = viewRange;
      const range = tMax - tMin;
      const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
      const newRange = Math.max(10000, Math.min(data.time_max - data.time_min, range * factor));
      const pivot = tMin + fraction * range;
      const newMin = Math.max(data.time_min, pivot - fraction * newRange);
      const newMax = Math.min(data.time_max, newMin + newRange);
      setViewRange([newMin, newMax]);
    },
    [viewRange, data, plotW],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const [tMin, tMax] = viewRange;
      const range = tMax - tMin;
      const panStep = range * 0.15;
      const fullRange = data.time_max - data.time_min;

      let newMin = tMin;
      let newMax = tMax;

      const atFullZoom = range >= fullRange * 0.99;

      switch (e.key.toLowerCase()) {
        case "a":
        case "arrowleft":
          if (atFullZoom) {
            newMax = tMin + range * 0.6;
            newMin = tMin;
          } else {
            newMin = Math.max(data.time_min, tMin - panStep);
            newMax = newMin + range;
          }
          break;
        case "d":
        case "arrowright":
          if (atFullZoom) {
            newMin = tMax - range * 0.6;
            newMax = tMax;
          } else {
            newMax = Math.min(data.time_max, tMax + panStep);
            newMin = newMax - range;
          }
          break;
        case "w":
        case "arrowup": {
          const newRange = Math.max(10000, range / 1.4);
          const center = (tMin + tMax) / 2;
          newMin = Math.max(data.time_min, center - newRange / 2);
          newMax = Math.min(data.time_max, newMin + newRange);
          break;
        }
        case "s":
        case "arrowdown": {
          const newRange = Math.min(fullRange, range * 1.4);
          const center = (tMin + tMax) / 2;
          newMin = Math.max(data.time_min, center - newRange / 2);
          newMax = Math.min(data.time_max, newMin + newRange);
          break;
        }
        case "r":
          newMin = data.time_min;
          newMax = data.time_max;
          break;
        default:
          return;
      }
      e.preventDefault();
      setViewRange([newMin, newMax]);
    },
    [viewRange, data],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 0) {
        setIsPanning(true);
        panStartRef.current = {
          x: e.clientX - e.currentTarget.getBoundingClientRect().left,
          range: [...viewRange] as [number, number],
        };
      }
    },
    [viewRange],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (panStartRef.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const moved = Math.abs(mx - panStartRef.current.x);
        if (moved < 3) {
          const hit = hitTest(mx, e.clientY - rect.top);
          setSelectedBlock(hit);
          setDetail(null);
          if (hit) {
            fetch(`/api/allocation_detail/${currentRank}/${hit.addr}`)
              .then((r) => r.json())
              .then(setDetail);
          }
        }
      }
      setIsPanning(false);
      panStartRef.current = null;
    },
    [hitTest, currentRank],
  );

  return (
    <div>
      <div style={{ position: "relative", cursor: isPanning ? "grabbing" : "crosshair" }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onMouseMove={handleMouseMove}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            setHoverBlock(null);
            setHoverPos(null);
            setIsPanning(false);
          }}
          onDoubleClick={() => setViewRange([data.time_min, data.time_max])}
        />
        {/* hover tooltip */}
        {hoverBlock && hoverPos && (
          <div
            style={{
              position: "absolute",
              left: Math.min(hoverPos.x + 12, width - 300),
              top: Math.max(hoverPos.y - 70, 4),
              background: "rgba(0,0,0,0.92)",
              border: "1px solid #444",
              borderRadius: 4,
              padding: "6px 10px",
              fontSize: 12,
              color: "#ddd",
              pointerEvents: "none",
              maxWidth: 340,
              fontFamily: "monospace",
              lineHeight: 1.5,
            }}
          >
            <div style={{ color: "#fff", fontWeight: 600 }}>{formatBytes(hoverBlock.size)}</div>
            <div>{hoverBlock.top_frame || `0x${hoverBlock.addr.toString(16)}`}</div>
            <div style={{ color: "#888" }}>
              {((hoverBlock.free_us - hoverBlock.alloc_us) / 1e6).toFixed(4)}s
              {hoverBlock.alive && " (alive)"}
            </div>
          </div>
        )}
        <div style={{ position: "absolute", bottom: 44, right: 24, fontSize: 11, color: "#444" }}>
          WASD/arrows=navigate W/S=zoom R=reset click=detail
        </div>
      </div>

      {/* detail panel */}
      {detail && (
        <div
          style={{
            marginTop: 8,
            background: "#111",
            border: "1px solid #333",
            borderRadius: 6,
            padding: 16,
            maxHeight: 300,
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
            <div>
              <span style={{ color: "#888" }}>Size: </span>
              <span style={{ color: "#fff" }}>{formatBytes(detail.size)}</span>
            </div>
            <div>
              <span style={{ color: "#888" }}>Duration: </span>
              <span style={{ color: "#fff" }}>
                {detail.free_us === -1
                  ? "alive"
                  : `${((detail.free_us - detail.alloc_us) / 1e6).toFixed(4)}s`}
              </span>
            </div>
            <div>
              <span style={{ color: "#888" }}>Address: </span>
              <span style={{ color: "#fff", fontFamily: "monospace" }}>
                0x{detail.addr.toString(16)}
              </span>
            </div>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.6 }}>
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
                  <div key={i} style={{ color: isPython ? "#93c5fd" : "#555" }}>
                    {f.name.length > 100 ? f.name.slice(0, 97) + "..." : f.name}
                    {f.filename && (
                      <span style={{ color: isPython ? "#60a5fa" : "#444" }}>
                        {" "}@ {f.filename.split("/").slice(-2).join("/")}:{f.line}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

interface PairedAnnotation {
  name: string;
  start: number;
  end: number;
}

function pairAnnotations(annotations: TimelineAnnotation[]): PairedAnnotation[] {
  const stack: Map<string, number[]> = new Map();
  const result: PairedAnnotation[] = [];
  for (const a of annotations) {
    if (a.stage === "START") {
      if (!stack.has(a.name)) stack.set(a.name, []);
      stack.get(a.name)!.push(a.time_us);
    } else if (a.stage === "END") {
      const starts = stack.get(a.name);
      if (starts && starts.length > 0) {
        result.push({ name: a.name, start: starts.pop()!, end: a.time_us });
      }
    }
  }
  return result;
}
