import { useEffect, useRef, useState, useCallback } from "react";
import type { FlameData, FlameNode } from "../compute";
import type { FrameRecord } from "../types/snapshot";

interface Props {
  flame: FlameData;
  framePool: FrameRecord[];
  width: number;
  height: number;
  /** Fires when the user drills in/out. -1 = "All" (no drill). The
   *  parent uses this to filter Top Allocs by stack-contains-frame. */
  onRootChange?: (frameIdx: number, label: string) => void;
}

const ROW_H = 20;
const MIN_RENDER_PX = 1.2;
const COLOR_BG = "#0a0a0b";
const FONT_MONO = '10px "JetBrains Mono", ui-monospace, monospace';
const COLOR_ACCENT = "#d9f99d";

// Curated theme-safe palette — each hue already appears somewhere in the
// dashboard (accent / peak red / private-pool amber etc). Frames get
// picked deterministically from this list; weight modulates brightness
// so heavy paths saturate and tiny frames fade to bg.
const HUES: ReadonlyArray<readonly [number, number, number]> = [
  [217, 249, 157],  // lime (accent)
  [251, 191, 36],   // amber (private-pool badge)
  [248, 113, 113],  // rose (peak red)
  [103, 232, 249],  // teal
  [196, 181, 253],  // violet
  [244, 114, 182],  // pink
];
const BG_COLD: [number, number, number] = [28, 28, 32];
function cellColor(frameIdx: number, weightT: number): string {
  const base = HUES[(frameIdx >= 0 ? frameIdx : 0) % HUES.length];
  // Floor at 0.18 so the dimmest cell is still visible, ceiling at 1.
  const t = Math.max(0.18, Math.min(1, weightT));
  const r = BG_COLD[0] + (base[0] - BG_COLD[0]) * t;
  const g = BG_COLD[1] + (base[1] - BG_COLD[1]) * t;
  const b = BG_COLD[2] + (base[2] - BG_COLD[2]) * t;
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

interface Crumb {
  frameIdx: number;
  label: string;
}

/**
 * Flame graph of where memory pressure came from, aggregated by call
 * stack. Width of each bar = size × lifetime contributed by allocs whose
 * stack passed through that frame. Root at the bottom, leaves at the
 * top. Hover to see the frame; click to drill in; use the breadcrumb to
 * pop back up.
 */
export default function MemoryFlamegraph({ flame, framePool, width, height, onRootChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dirtyRef = useRef(true);
  const hoverRef = useRef<FlameNode | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Drill-in history as a breadcrumb trail (latest = current root).
  // Empty = viewing everything from "All".
  const [trail, setTrail] = useState<Crumb[]>([]);
  const rootFrameIdx = trail.length > 0 ? trail[trail.length - 1].frameIdx : -1;

  const labelFor = useCallback(
    (frameIdx: number) => {
      if (frameIdx < 0) return "All";
      const f = framePool[frameIdx];
      if (!f) return "?";
      return f.name.split("(")[0].split("<")[0].trim();
    },
    [framePool],
  );

  // Reset trail when a new rank is loaded. flame identity changes on
  // setCurrentRank so this fires once per switch.
  useEffect(() => {
    setTrail([]);
    dirtyRef.current = true;
  }, [flame]);

  // Publish current root upward so the parent can filter Top Allocs.
  useEffect(() => {
    if (!onRootChange) return;
    const idx = trail.length > 0 ? trail[trail.length - 1].frameIdx : -1;
    const label = trail.length > 0 ? trail[trail.length - 1].label : "";
    onRootChange(idx, label);
  }, [trail, onRootChange]);

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

    function visibleRoot(): { start: number; weight: number; depth: number } {
      if (rootFrameIdx < 0) return { start: 0, weight: flame.totalWeight, depth: 0 };
      // The node matching frameIdx with highest weight wins — because
      // flatten sorts children by weight desc, the first match is that.
      const n = flame.nodes.find((x) => x.frameIdx === rootFrameIdx);
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
      const rowH = Math.min(ROW_H, Math.max(12, Math.floor(height / (depthSpan + 1))));
      const wPerUnit = visWeight > 0 ? width / visWeight : 0;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, width, height);

      const hover = hoverRef.current;

      for (const n of flame.nodes) {
        if (n.depth < visDepth) continue;
        const nStart = n.xStart - start;
        const nEnd = nStart + n.weight;
        if (nEnd <= 0 || nStart >= visWeight) continue;
        const x = Math.max(0, nStart) * wPerUnit;
        const w = Math.max(MIN_RENDER_PX, (Math.min(nEnd, visWeight) - Math.max(nStart, 0)) * wPerUnit);
        const relDepth = n.depth - visDepth;
        const y = height - (relDepth + 1) * rowH;

        // Frame picks its hue from the 6-color theme palette; weight
        // modulates saturation so heavy paths pop and tiny leaves fade.
        const t = visWeight > 0 ? Math.pow(n.weight / visWeight, 0.45) : 0;
        ctx.fillStyle = n.frameIdx < 0 ? COLOR_ACCENT : cellColor(n.frameIdx, t);
        ctx.fillRect(x, y, w, rowH - 1);

        if (w > 30) {
          const label = labelFor(n.frameIdx);
          const maxChars = Math.floor((w - 8) / 6);
          const text = label.length > maxChars ? label.slice(0, Math.max(1, maxChars - 1)) + "\u2026" : label;
          // Stroke + fill gives crisp text against *any* cell color —
          // no more dark-on-dark unreadable labels.
          ctx.font = FONT_MONO;
          ctx.textBaseline = "middle";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(10,10,11,0.75)";
          ctx.strokeText(text, x + 6, y + (rowH - 1) / 2 + 0.5);
          ctx.fillStyle = "rgba(250,250,250,0.96)";
          ctx.fillText(text, x + 6, y + (rowH - 1) / 2 + 0.5);
        }

        if (hover && hover === n) {
          // Semi-transparent accent wash + hairline edge — feels like a
          // highlight laid on top of the cell rather than a frame box.
          ctx.fillStyle = "rgba(217,249,157,0.25)";
          ctx.fillRect(x, y, w, rowH - 1);
          ctx.strokeStyle = "rgba(217,249,157,0.75)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, rowH - 2);
        }
      }
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [flame, framePool, width, height, rootFrameIdx, labelFor]);

  function nodeAtPos(mx: number, my: number): FlameNode | null {
    const start = rootFrameIdx < 0 ? 0 : (flame.nodes.find((x) => x.frameIdx === rootFrameIdx)?.xStart ?? 0);
    const visDepth = rootFrameIdx < 0 ? 0 : (flame.nodes.find((x) => x.frameIdx === rootFrameIdx)?.depth ?? 0);
    const visWeight =
      rootFrameIdx < 0 ? flame.totalWeight : (flame.nodes.find((x) => x.frameIdx === rootFrameIdx)?.weight ?? flame.totalWeight);
    const depthSpan = Math.max(1, flame.maxDepth - visDepth);
    const rowH = Math.min(ROW_H, Math.max(12, Math.floor(height / (depthSpan + 1))));
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
    if (!hit) {
      tip.style.display = "none";
      return;
    }
    const f = hit.frameIdx >= 0 ? framePool[hit.frameIdx] : null;
    const pct = flame.totalWeight > 0 ? ((hit.weight / flame.totalWeight) * 100).toFixed(1) : "—";
    const label = labelFor(hit.frameIdx);
    const file = f
      ? (() => {
          const i = f.filename.lastIndexOf("/");
          return `${i >= 0 ? f.filename.slice(i + 1) : f.filename}:${f.line}`;
        })()
      : "";
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
    if (hit.frameIdx < 0) {
      setTrail([]);
    } else if (hit.frameIdx === rootFrameIdx) {
      // Clicking the current root pops back up one level.
      setTrail((t) => t.slice(0, -1));
    } else {
      setTrail((t) => [...t, { frameIdx: hit.frameIdx, label: labelFor(hit.frameIdx) }]);
    }
  };

  return (
    <div style={{ position: "relative", width }}>
      <div className="fg-crumbs mono">
        <button
          type="button"
          className={"fg-crumb" + (trail.length === 0 ? " is-current" : "")}
          onClick={() => setTrail([])}
          title="Show the whole call-stack tree"
        >
          All
        </button>
        {trail.map((c, i) => (
          <span key={`${c.frameIdx}-${i}`} style={{ display: "inline-flex", alignItems: "center" }}>
            <span className="fg-crumb-sep">›</span>
            <button
              type="button"
              className={"fg-crumb" + (i === trail.length - 1 ? " is-current" : "")}
              onClick={() => setTrail((t) => t.slice(0, i + 1))}
              title={c.label}
            >
              {c.label.length > 36 ? c.label.slice(0, 35) + "\u2026" : c.label}
            </button>
          </span>
        ))}
        {trail.length > 0 && (
          <span className="fg-crumbs-hint faint">double-click graph to reset</span>
        )}
      </div>

      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onDoubleClick={() => setTrail([])}
        style={{ cursor: "pointer", display: "block" }}
      />

      <div ref={tooltipRef} className="fg-tooltip" />

      <style>{`
        .fg-crumbs {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          padding: 4px 0 8px;
          font-size: 11px;
        }
        .fg-crumb {
          appearance: none;
          background: transparent;
          border: 1px solid var(--border);
          color: var(--fg-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          padding: 2px 8px;
          cursor: pointer;
          letter-spacing: 0.02em;
          max-width: 240px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fg-crumb:hover { color: var(--fg); border-color: var(--border-strong); }
        .fg-crumb.is-current {
          color: var(--accent);
          border-color: var(--accent);
          background: var(--accent-bg);
        }
        .fg-crumb-sep {
          color: var(--fg-faint);
          margin: 0 4px;
        }
        .fg-crumbs-hint {
          margin-left: auto;
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .fg-tooltip {
          position: absolute;
          display: none;
          pointer-events: none;
          padding: 8px 12px;
          background: rgba(10,10,11,0.55);
          border: 1px solid rgba(42,42,47,0.6);
          max-width: 360px;
          line-height: 1.5;
          z-index: 2;
          backdrop-filter: blur(16px) saturate(1.1);
          -webkit-backdrop-filter: blur(16px) saturate(1.1);
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
