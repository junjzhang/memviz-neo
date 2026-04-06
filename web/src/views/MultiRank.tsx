import { Card } from "antd";
import type { RankSummary } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  data: RankSummary[];
  currentRank: number;
  onSelectRank: (rank: number) => void;
}

export default function MultiRank({ data, currentRank, onSelectRank }: Props) {
  if (!data.length) return null;

  const maxReserved = Math.max(...data.map((d) => d.total_reserved));

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {data.map((rank) => {
        const pct = (rank.total_allocated / rank.total_reserved) * 100;
        const isSelected = rank.rank === currentRank;

        return (
          <Card
            key={rank.rank}
            size="small"
            onClick={() => onSelectRank(rank.rank)}
            style={{
              width: 160,
              cursor: "pointer",
              borderColor: isSelected ? "#1677ff" : "#303030",
              background: isSelected ? "#111a2e" : "#141414",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Rank {rank.rank}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>
              {formatBytes(rank.total_allocated)} /{" "}
              {formatBytes(rank.total_reserved)}
            </div>
            <div
              style={{
                height: 12,
                background: "#222",
                borderRadius: 2,
                overflow: "hidden",
                display: "flex",
              }}
            >
              <div
                style={{
                  width: `${(rank.active_bytes / maxReserved) * 100}%`,
                  background: "#3b82f6",
                  height: "100%",
                }}
              />
              <div
                style={{
                  width: `${(rank.inactive_bytes / maxReserved) * 100}%`,
                  background: "#444",
                  height: "100%",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 10,
                color: "#666",
                marginTop: 4,
                textAlign: "right",
              }}
            >
              {pct.toFixed(1)}% used
            </div>
          </Card>
        );
      })}
    </div>
  );
}
