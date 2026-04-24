import { memo, useCallback, useState } from "react";
import { formatBytes } from "../utils";
import { useRankSummaries, summaryMetrics } from "../stores/rankStore";
import { useFileStore } from "../stores/fileStore";
import { useDataStore } from "../stores/dataStore";

interface Props {
  allRanks: number[];
  onSelectRank: (rank: number) => void;
}

export default function RankSidebar({ allRanks, onSelectRank }: Props) {
  const currentRank = useDataStore((s) => s.currentRank);
  const completedCount = useFileStore((s) => s.completedCount);
  const totalCount = useFileStore((s) => s.totalCount);
  const maxPeak = useRankSummaries((s) => s.maxPeak);
  const [collapsed, setCollapsed] = useState(false);
  const stillLoading = completedCount < totalCount;

  if (allRanks.length === 0) return null;

  return (
    <aside className={"rank-sidebar" + (collapsed ? " is-collapsed" : "")}>
      <div className="rank-sidebar-head mono">
        {!collapsed && (
          <>
            <span className="eyebrow">Ranks</span>
            <span className="rank-sidebar-count">
              {stillLoading ? (
                <>
                  <span className="hl">{completedCount}</span>
                  <span className="faint">/ {totalCount}</span>
                </>
              ) : (
                <span className="faint">{allRanks.length}</span>
              )}
            </span>
          </>
        )}
        <button
          className="rank-sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </div>

      <div className="rank-sidebar-list">
        {allRanks.map((r) => (
          <Row
            key={r}
            rank={r}
            isSelected={r === currentRank}
            maxPeak={maxPeak}
            collapsed={collapsed}
            onSelect={onSelectRank}
          />
        ))}
      </div>

      <style>{STYLES}</style>
    </aside>
  );
}

const Row = memo(function Row({
  rank, isSelected, maxPeak, collapsed, onSelect,
}: {
  rank: number;
  isSelected: boolean;
  maxPeak: number;
  collapsed: boolean;
  onSelect: (r: number) => void;
}) {
  const summary = useRankSummaries((s) => s.summaries[rank]);
  const loaded = summary !== undefined;
  const { baseline, windowDelta } = summaryMetrics(summary);
  const baseW = loaded ? (baseline / maxPeak) * 100 : 0;
  const activeW = loaded ? (windowDelta / maxPeak) * 100 : 0;

  const handleClick = useCallback(() => onSelect(rank), [onSelect, rank]);
  const tag = `R${String(rank).padStart(2, "0")}`;
  const peakBytes = summary?.peak_bytes ?? summary?.active_bytes ?? 0;

  return (
    <button
      className={
        "rank-row" +
        (isSelected ? " is-selected" : "") +
        (loaded ? "" : " is-pending")
      }
      onClick={handleClick}
      title={loaded ? `${tag} · peak ${formatBytes(peakBytes)}` : `${tag} loading…`}
    >
      <span className="rank-row-tag mono">{tag}</span>
      {!collapsed && (
        <>
          <span className="rank-row-bar">
            {loaded ? (
              <>
                <span className="rank-row-bar-baseline" style={{ width: `${baseW}%` }} />
                <span className="rank-row-bar-active" style={{ width: `${activeW}%` }} />
              </>
            ) : (
              <span className="rank-row-bar-pending" />
            )}
          </span>
          <span className="rank-row-peak mono">
            {loaded ? formatBytes(peakBytes) : "…"}
          </span>
        </>
      )}
    </button>
  );
});

const STYLES = `
  .rank-sidebar {
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-right: 1px solid var(--border);
    width: 220px;
    min-width: 220px;
    transition: width 140ms var(--ease), min-width 140ms var(--ease);
    overflow: hidden;
  }
  .rank-sidebar.is-collapsed {
    width: 52px;
    min-width: 52px;
  }
  .rank-sidebar-head {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s4);
    border-bottom: 1px solid var(--divider);
    font-size: 11px;
    color: var(--fg-faint);
    flex: 0 0 auto;
  }
  .rank-sidebar-count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .rank-sidebar-toggle {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-faint);
    cursor: pointer;
    padding: 0 6px;
    font-size: 12px;
    line-height: 18px;
    margin-left: auto;
  }
  .rank-sidebar.is-collapsed .rank-sidebar-toggle { margin: 0 auto; }
  .rank-sidebar-toggle:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  .rank-sidebar-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 6px 0;
  }
  .rank-row {
    appearance: none;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    padding: 6px 12px;
    cursor: pointer;
    display: grid;
    grid-template-columns: 38px 1fr auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    color: var(--fg-muted);
    text-align: left;
  }
  .rank-sidebar.is-collapsed .rank-row {
    grid-template-columns: 1fr;
    padding: 8px 0;
    justify-items: center;
  }
  .rank-row:hover { background: var(--bg-elev); color: var(--fg); }
  .rank-row.is-selected {
    background: var(--bg-elev);
    color: var(--fg);
    border-left-color: var(--accent);
  }
  .rank-row.is-pending { cursor: default; }
  .rank-row.is-pending:hover { background: transparent; }
  .rank-row-tag {
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--fg);
  }
  .rank-row.is-selected .rank-row-tag { color: var(--accent); }
  .rank-row-bar {
    position: relative;
    height: 12px;
    background: var(--bg-elev-2);
    display: flex;
    overflow: hidden;
  }
  .rank-row-bar-baseline {
    display: block;
    background:
      repeating-linear-gradient(
        45deg,
        rgba(113,113,122,0.55) 0 2px,
        rgba(63,63,70,0.75) 2px 5px
      );
  }
  .rank-row-bar-active {
    display: block;
    background: var(--fg-dim);
  }
  .rank-row:hover .rank-row-bar-active { background: var(--fg-muted); }
  .rank-row.is-selected .rank-row-bar-active { background: var(--accent); }
  .rank-row-bar-pending {
    display: block;
    flex: 1;
    background: repeating-linear-gradient(
      45deg,
      var(--border) 0 4px,
      transparent 4px 8px
    );
    opacity: 0.55;
    animation: rank-pending-pulse 1.8s ease-in-out infinite;
  }
  @keyframes rank-pending-pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 0.75; }
  }
  .rank-row-peak {
    font-size: 10px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
`;
