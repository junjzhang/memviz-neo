import { useState } from "react";
import type { SegmentInfo, BlockInfo } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  segments: SegmentInfo[];
  width: number;
}

interface HoverInfo {
  x: number;
  y: number;
  block: BlockInfo;
}

export default function AddressMap({ segments, width }: Props) {
  const [hover, setHover] = useState<HoverInfo | null>(null);

  if (!segments.length) return null;

  const maxSize = Math.max(...segments.map((s) => s.total_size));
  const barHeight = 20;
  const gap = 3;
  const labelWidth = 96;
  const barWidth = width - labelWidth - 12;
  const totalH = (barHeight + gap) * segments.length + 4;

  return (
    <div style={{ position: "relative" }}>
      <svg
        width={width}
        height={totalH}
        onMouseLeave={() => setHover(null)}
      >
        {segments.map((seg, si) => {
          const y = si * (barHeight + gap) + 2;
          const scale = barWidth / maxSize;
          const segW = seg.total_size * scale;

          return (
            <g key={seg.address}>
              <text
                x={labelWidth - 8}
                y={y + 14}
                fontSize={10}
                fill="#52525b"
                fontFamily='"JetBrains Mono", monospace'
                textAnchor="end"
              >
                {formatBytes(seg.total_size)}
              </text>
              <rect
                x={labelWidth}
                y={y}
                width={segW}
                height={barHeight}
                fill="#111113"
                stroke="#1f1f23"
                strokeWidth={1}
              />
              {seg.blocks.map((block, bi) => {
                const bx = labelWidth + block.offset_in_segment * scale;
                const bw = Math.max(block.size * scale, 0.5);
                const isActive = block.state === "active_allocated";
                const color = isActive ? "#d9f99d" : "#3f3f46";

                return (
                  <rect
                    key={bi}
                    x={bx}
                    y={y}
                    width={bw}
                    height={barHeight}
                    fill={color}
                    opacity={isActive ? 0.9 : 0.4}
                    onMouseMove={(e) => {
                      const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, block });
                    }}
                  />
                );
              })}
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
          <div style={{ color: "var(--accent)" }}>{formatBytes(hover.block.size)}</div>
          <div style={{ color: "var(--fg-muted)" }}>{hover.block.state}</div>
          {hover.block.top_frame && (
            <div style={{ color: "var(--fg-muted)", marginTop: 2 }}>{hover.block.top_frame}</div>
          )}
          <div style={{ color: "var(--fg-dim)" }}>0x{hover.block.address.toString(16)}</div>
        </div>
      )}
    </div>
  );
}
