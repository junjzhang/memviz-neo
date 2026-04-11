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
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {data.map((rank) => {
        const pct = (rank.total_allocated / rank.total_reserved) * 100;
        const isSelected = rank.rank === currentRank;
        const activePct = (rank.active_bytes / maxReserved) * 100;
        const inactivePct = (rank.inactive_bytes / maxReserved) * 100;

        return (
          <div
            key={rank.rank}
            className={"rank-card" + (isSelected ? " is-selected" : "")}
            onClick={() => onSelectRank(rank.rank)}
          >
            <div
              className="display"
              style={{
                fontSize: 11,
                letterSpacing: "0.12em",
                color: "var(--fg-faint)",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Rank {String(rank.rank).padStart(2, "0")}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 16,
                color: "var(--fg)",
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.01em",
              }}
            >
              {formatBytes(rank.total_allocated)}
            </div>
            <div
              className="mono faint"
              style={{ fontSize: 11, marginBottom: 10 }}
            >
              / {formatBytes(rank.total_reserved)}
            </div>

            <div
              style={{
                height: 4,
                background: "var(--bg)",
                display: "flex",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${activePct}%`,
                  background: isSelected ? "var(--accent)" : "var(--fg-muted)",
                  height: "100%",
                  transition: "width 200ms var(--ease)",
                }}
              />
              <div
                style={{
                  width: `${inactivePct}%`,
                  background: "var(--border-strong)",
                  height: "100%",
                }}
              />
            </div>

            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--fg-faint)",
                marginTop: 6,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>{pct.toFixed(1)}%</span>
              <span>util</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
