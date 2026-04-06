import { Tooltip } from "antd";
import type { SegmentInfo } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  segments: SegmentInfo[];
  width: number;
}

export default function AddressMap({ segments, width }: Props) {
  if (!segments.length) return null;

  const maxSize = Math.max(...segments.map((s) => s.total_size));
  const barHeight = 18;
  const gap = 2;
  const labelWidth = 90;
  const barWidth = width - labelWidth - 10;

  return (
    <svg width={width} height={(barHeight + gap) * segments.length + 4}>
      {segments.map((seg, si) => {
        const y = si * (barHeight + gap) + 2;
        const scale = barWidth / maxSize;
        const segW = seg.total_size * scale;

        return (
          <g key={seg.address}>
            <text
              x={0}
              y={y + 13}
              fontSize={10}
              fill="#888"
              fontFamily="monospace"
            >
              {formatBytes(seg.total_size)}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={segW}
              height={barHeight}
              fill="#222"
              rx={2}
            />
            {seg.blocks.map((block, bi) => {
              const bx = labelWidth + block.offset_in_segment * scale;
              const bw = Math.max(block.size * scale, 0.5);
              const color =
                block.state === "active_allocated" ? "#3b82f6" : "#444";

              return (
                <Tooltip
                  key={bi}
                  title={
                    <div style={{ fontSize: 12 }}>
                      <div>{formatBytes(block.size)}</div>
                      <div>{block.state}</div>
                      {block.top_frame && <div>{block.top_frame}</div>}
                      <div style={{ fontFamily: "monospace" }}>
                        0x{block.address.toString(16)}
                      </div>
                    </div>
                  }
                >
                  <rect
                    x={bx}
                    y={y}
                    width={bw}
                    height={barHeight}
                    fill={color}
                    opacity={block.state === "inactive" ? 0.4 : 0.85}
                  />
                </Tooltip>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
