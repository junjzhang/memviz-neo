import { useEffect, useRef } from "react";
import type { FlameData, FlameNode } from "../compute";
import type { FrameRecord } from "../types/snapshot";
import { blockColor } from "../compute/palette";

interface Props {
  flame: FlameData;
  framePool: FrameRecord[];
  width: number;
  height: number;
}

const ROW_H = 18;
const MIN_RENDER_PX = 1.2;
const COLOR_BG = "#0a0a0b";
const COLOR_STROKE = "#0a0a0b";
const FONT_MONO = '10px "JetBrains Mono", ui-monospace, monospace';

/**
 * Flame graph of where memory pressure came from, aggregated by
 * call stack. Width of each bar = size × lifetime contributed by allocs
 * whose stack passed through that frame. Root at the bottom, leaves at
 * the top. Hover to see the frame; click to drill in (reset to that
 * frame as the new root); click the "All" header or press Escape to
 * reset.
 */
export default function MemoryFlamegraph({ flame, framePool, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootFrameIdxRef = useRef<number>(-1); // -1 means "show everything"
  const dirtyRef = useRef(true);
  const hoverRef = useRef<FlameNode | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => { rootFrameIdxRef.current = -1; dirtyRef.current = true; }, [flame]);

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

    // Resolve visible nodes. If a drill-in root is set, filter to the
    // subtree rooted there (nodes whose depth >= root's depth and whose
    // xStart falls inside the root's [xStart, xStart+weight) range).
    function visibleRoot(): { start: number; weight: number; depth: number } {
      const nodes = flame.nodes;
      const target = rootFrameIdxRef.current;
      if (target < 0) return { start: 0, weight: flame.totalWeight, depth: 0 };
      // Pick the first (highest-weight) node matching that frame idx
      // since our flatten sorts children by weight desc.
      const n = nodes.find((x) => x.frameIdx === target);
      if (!n) return { start: 0, weight: flame.totalWeight, depth: 0 };
      return { start: n.xStart, weight: n.weight, depth: n.depth };
    }

    let rafId = 0;
    const draw = () => {
      rafId = requestAnimationFrame(draw);
      if (!dirtyRef.current) return;
      dirtyRef.current = false;

      const { start, weight: visWeight, depth: visDepth } = visibleRoot();
      const depthSpan = Math.max(1, flame.maxDepth - visDepth);
      const effectiveRowH = Math.min(ROW_H, Math.max(10, Math.floor(height / (depthSpan + 1))));
      const wPerUnit = visWeight > 0 ? width / visWeight : 0;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, width, height);

      // Flame convention: root at the BOTTOM of the view. depth 0 is at
      // the bottom row, deeper frames rise upward. If we're drilled in,
      // depth `visDepth` becomes the new bottom.
      for (const n of flame.nodes) {
        if (n.depth < visDepth) continue;
        const nStart = n.xStart - start;
        const nEnd = nStart + n.weight;
        if (nEnd <= 0 || nStart >= visWeight) continue;
        const x = Math.max(0, nStart) * wPerUnit;
        const w = Math.max(MIN_RENDER_PX, (Math.min(nEnd, visWeight) - Math.max(nStart, 0)) * wPerUnit);
        const relDepth = n.depth - visDepth;
        const y = height - (relDepth + 1) * effectiveRowH;

        const [r, g, b] = n.frameIdx < 0
          ? [0.3, 0.3, 0.35]
          : blockColor(n.frameIdx, 0);
        ctx.fillStyle = `rgb(${r * 255 | 0}, ${g * 255 | 0}, ${b * 255 | 0})`;
        ctx.fillRect(x, y, w, effectiveRowH - 1);

        // Label if wide enough
        if (w > 32) {
          const f = n.frameIdx >= 0 ? framePool[n.frameIdx] : null;
          const label = n.frameIdx < 0 ? "All" : (f ? f.name : "?");
          const short = label.split("(")[0].split("<")[0].trim();
          const maxChars = Math.floor((w - 6) / 6);
          const text = short.length > maxChars ? short.slice(0, Math.max(1, maxChars - 1)) + "…" : short;
          ctx.font = FONT_MONO;
          ctx.fillStyle = "rgba(10,10,11,0.85)";
          ctx.textBaseline = "middle";
          ctx.fillText(text, x + 4, y + (effectiveRowH - 1) / 2 + 1);
        }

        // Separator
        ctx.strokeStyle = COLOR_STROKE;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, effectiveRowH - 2);
      }
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [flame, framePool, width, height]);

  function nodeAtPos(mx: number, my: number): FlameNode | null {
    const { start, weight: visWeight, depth: visDepth } = (() => {
      const target = rootFrameIdxRef.current;
      if (target < 0) return { start: 0, weight: flame.totalWeight, depth: 0 };
      const n = flame.nodes.find((x) => x.frameIdx === target);
      if (!n) return { start: 0, weight: flame.totalWeight, depth: 0 };
      return { start: n.xStart, weight: n.weight, depth: n.depth };
    })();
    const depthSpan = Math.max(1, flame.maxDepth - visDepth);
    const rowH = Math.min(ROW_H, Math.max(10, Math.floor(height / (depthSpan + 1))));
    const relDepth = Math.floor((height - my) / rowH);
    const targetDepth = visDepth + relDepth;
    const timeAtMx = start + (mx / width) * visWeight;
    for (const n of flame.nodes) {
      if (n.depth !== targetDepth) continue;
      if (timeAtMx >= n.xStart && timeAtMx < n.xStart + n.weight) return n;
    }
    return null;
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = nodeAtPos(mx, my);
    if (hit !== hoverRef.current) {
      hoverRef.current = hit;
      dirtyRef.current = true;
    }
    const tip = tooltipRef.current;
    if (!tip) return;
    if (!hit) { tip.style.display = "none"; return; }
    const f = hit.frameIdx >= 0 ? framePool[hit.frameIdx] : null;
    const pct = flame.totalWeight > 0 ? ((hit.weight / flame.totalWeight) * 100).toFixed(1) : "—";
    const label = hit.frameIdx < 0 ? "All" : (f ? f.name.split("(")[0].split("<")[0].trim() : "?");
    const file = f ? (() => {
      const i = f.filename.lastIndexOf("/");
      return `${i >= 0 ? f.filename.slice(i + 1) : f.filename}:${f.line}`;
    })() : "";
    tip.innerHTML = `
      <div class="fg-tip-eyebrow">${pct}% of total pressure</div>
      <div class="fg-tip-name">${escapeHtml(label)}</div>
      ${file ? `<div class="fg-tip-file">${escapeHtml(file)}</div>` : ""}
    `;
    tip.style.display = "block";
    tip.style.left = `${Math.min(mx + 12, width - 260)}px`;
    tip.style.top = `${Math.max(my - 48, 4)}px`;
  };

  const handleMouseLeave = () => {
    hoverRef.current = null;
    dirtyRef.current = true;
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  };

  const handleClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = nodeAtPos(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (hit.frameIdx < 0) rootFrameIdxRef.current = -1;
    else rootFrameIdxRef.current = hit.frameIdx;
    dirtyRef.current = true;
  };

  return (
    <div style={{ position: "relative", width, height }}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onDoubleClick={() => { rootFrameIdxRef.current = -1; dirtyRef.current = true; }}
        style={{ cursor: "pointer", display: "block" }}
      />
      <div ref={tooltipRef} className="fg-tooltip" />
      <style>{`
        .fg-tooltip {
          position: absolute;
          display: none;
          pointer-events: none;
          padding: 6px 10px;
          background: rgba(10,10,11,0.96);
          border: 1px solid var(--border-strong);
          max-width: 360px;
          line-height: 1.5;
          z-index: 2;
          backdrop-filter: blur(8px);
        }
        .fg-tip-eyebrow {
          font-family: var(--font-display);
          font-size: 9px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--accent);
        }
        .fg-tip-name {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--fg);
          word-break: break-all;
        }
        .fg-tip-file {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--fg-faint);
          margin-top: 2px;
        }
      `}</style>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
