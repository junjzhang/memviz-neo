import { useMemo, useState, useCallback } from "react";
import { Tooltip } from "antd";
import * as d3Hierarchy from "d3-hierarchy";
import type { TreemapNode } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  data: TreemapNode;
  width: number;
  height: number;
}

function depthColor(depth: number, index: number): string {
  const hue = (index * 47 + depth * 90) % 360;
  const lightness = 35 + depth * 8;
  return `hsl(${hue}, 55%, ${lightness}%)`;
}

export default function Treemap({ data, width, height }: Props) {
  const [drillPath, setDrillPath] = useState<string[]>([]);

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
        setDrillPath([...drillPath, node.name]);
      }
    },
    [drillPath],
  );

  const handleBreadcrumb = useCallback((index: number) => {
    setDrillPath((prev) => prev.slice(0, index));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: 13, color: "#888" }}>
        <span
          onClick={() => handleBreadcrumb(0)}
          style={{ cursor: "pointer", color: "#1677ff" }}
        >
          root
        </span>
        {drillPath.map((name, i) => (
          <span key={i}>
            {" / "}
            <span
              onClick={() => handleBreadcrumb(i + 1)}
              style={{ cursor: "pointer", color: "#1677ff" }}
            >
              {name}
            </span>
          </span>
        ))}
      </div>
      <svg width={width} height={height}>
        {layout.map((leaf, i) => {
          const d = leaf.data;
          const x0 = leaf.x0 ?? 0;
          const y0 = leaf.y0 ?? 0;
          const w = (leaf.x1 ?? 0) - x0;
          const h = (leaf.y1 ?? 0) - y0;
          if (w < 1 || h < 1) return null;

          const color = depthColor(leaf.depth, i);
          const label = w > 60 && h > 20 ? d.name : "";
          const sizeLabel = w > 40 && h > 36 ? formatBytes(d.size) : "";

          const parent = leaf.parent?.data;

          return (
            <Tooltip
              key={i}
              title={
                <div>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  <div>Size: {formatBytes(d.size)}</div>
                  {d.top_frame && <div>Source: {d.top_frame}</div>}
                  {d.address != null && (
                    <div style={{ fontFamily: "monospace" }}>
                      0x{d.address.toString(16)}
                    </div>
                  )}
                </div>
              }
            >
              <g
                onClick={() => parent && handleClick(parent)}
                style={{ cursor: parent?.children ? "pointer" : "default" }}
              >
                <rect
                  x={x0}
                  y={y0}
                  width={w}
                  height={h}
                  fill={color}
                  stroke="#222"
                  strokeWidth={1}
                  opacity={0.85}
                />
                {label && (
                  <text
                    x={x0 + 4}
                    y={y0 + 14}
                    fontSize={11}
                    fill="#fff"
                    style={{ pointerEvents: "none" }}
                  >
                    {label.length > w / 7
                      ? label.slice(0, Math.floor(w / 7)) + "..."
                      : label}
                  </text>
                )}
                {sizeLabel && (
                  <text
                    x={x0 + 4}
                    y={y0 + 28}
                    fontSize={10}
                    fill="rgba(255,255,255,0.8)"
                    style={{ pointerEvents: "none" }}
                  >
                    {sizeLabel}
                  </text>
                )}
              </g>
            </Tooltip>
          );
        })}
      </svg>
    </div>
  );
}
