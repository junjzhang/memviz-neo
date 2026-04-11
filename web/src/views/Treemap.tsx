import { useMemo, useState, useCallback } from "react";
import * as d3Hierarchy from "d3-hierarchy";
import type { TreemapNode } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  data: TreemapNode;
  width: number;
  height: number;
}

// Muted palette mirrors glRenderer.ts
const PALETTE = [
  "#6b8fba", "#7d7cba", "#947cba", "#b07cb5",
  "#b07c93", "#b08a7c", "#b09f7c", "#8ab07c",
  "#7cb08a", "#7cb0a3", "#7c9eb0", "#7c87b0",
];

function depthColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

interface HoverInfo {
  x: number;
  y: number;
  data: TreemapNode;
}

export default function Treemap({ data, width, height }: Props) {
  const [drillPath, setDrillPath] = useState<string[]>([]);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const currentNode = useMemo(() => {
    let node = data;
    for (const name of drillPath) {
      const child = node.children?.find((c) => c.name === name);
      if (!child || !child.children) break;
      node = child;
    }
    return node;
  }, [data, drillPath]);

  const layout = useMemo(() => {
    const root = d3Hierarchy
      .hierarchy(currentNode)
      .sum((d) => (d.children ? 0 : d.size))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const treemapLayout = d3Hierarchy
      .treemap<TreemapNode>()
      .size([width, height])
      .padding(2)
      .round(true);

    return treemapLayout(root).leaves();
  }, [currentNode, width, height]);

  const handleClick = useCallback(
    (node: TreemapNode) => {
      if (node.children && node.children.length > 0) {
        setDrillPath((p) => [...p, node.name]);
      }
    },
    [],
  );

  const handleBreadcrumb = useCallback((index: number) => {
    setDrillPath((prev) => prev.slice(0, index));
  }, []);

  // Reset hover/drill when data changes (rank switch)
  useMemo(() => {
    setHover(null);
  }, [data]);

  return (
    <div style={{ position: "relative" }}>
      <div
        className="mono"
        style={{
          marginBottom: 12,
          fontSize: 11,
          color: "var(--fg-faint)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          onClick={() => handleBreadcrumb(0)}
          style={{
            cursor: "pointer",
            color: drillPath.length === 0 ? "var(--accent)" : "var(--fg-muted)",
          }}
        >
          root
        </span>
        {drillPath.map((name, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--fg-dim)" }}>/</span>
            <span
              onClick={() => handleBreadcrumb(i + 1)}
              style={{
                cursor: "pointer",
                color: i === drillPath.length - 1 ? "var(--accent)" : "var(--fg-muted)",
              }}
            >
              {name}
            </span>
          </span>
        ))}
      </div>
      <svg
        width={width}
        height={height}
        style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", display: "block" }}
        onMouseLeave={() => setHover(null)}
      >
        {layout.map((leaf, i) => {
          const d = leaf.data;
          const x0 = leaf.x0 ?? 0;
          const y0 = leaf.y0 ?? 0;
          const w = (leaf.x1 ?? 0) - x0;
          const h = (leaf.y1 ?? 0) - y0;
          if (w < 1 || h < 1) return null;

          const color = depthColor(i);
          const label = w > 60 && h > 20 ? d.name : "";
          const sizeLabel = w > 40 && h > 36 ? formatBytes(d.size) : "";

          const parent = leaf.parent?.data;

          return (
            <g
              key={i}
              onClick={() => parent && handleClick(parent)}
              onMouseMove={(e) => {
                const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, data: d });
              }}
              style={{ cursor: parent?.children ? "pointer" : "default" }}
            >
              <rect
                x={x0}
                y={y0}
                width={w}
                height={h}
                fill={color}
                stroke="#0a0a0b"
                strokeWidth={1}
                opacity={0.88}
              />
              {label && (
                <text
                  x={x0 + 6}
                  y={y0 + 14}
                  fontSize={10}
                  fontFamily='"Inter", sans-serif'
                  fontWeight={500}
                  fill="#fafafa"
                  style={{ pointerEvents: "none" }}
                >
                  {label.length > w / 6.5
                    ? label.slice(0, Math.floor(w / 6.5)) + "…"
                    : label}
                </text>
              )}
              {sizeLabel && (
                <text
                  x={x0 + 6}
                  y={y0 + 27}
                  fontSize={9}
                  fontFamily='"JetBrains Mono", monospace'
                  fill="rgba(250,250,250,0.65)"
                  style={{ pointerEvents: "none" }}
                >
                  {sizeLabel}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            left: Math.min(hover.x + 12, width - 280),
            top: Math.max(hover.y + 12, 4),
            background: "rgba(10,10,11,0.96)",
            border: "1px solid var(--border-strong)",
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--fg)",
            pointerEvents: "none",
            maxWidth: 340,
            lineHeight: 1.5,
            backdropFilter: "blur(12px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{ color: "var(--fg)", marginBottom: 2, fontWeight: 500 }}>{hover.data.name}</div>
          <div style={{ color: "var(--accent)" }}>{formatBytes(hover.data.size)}</div>
          {hover.data.top_frame && (
            <div style={{ color: "var(--fg-muted)", marginTop: 2 }}>{hover.data.top_frame}</div>
          )}
          {hover.data.address != null && (
            <div style={{ color: "var(--fg-dim)" }}>0x{hover.data.address.toString(16)}</div>
          )}
        </div>
      )}
    </div>
  );
}
