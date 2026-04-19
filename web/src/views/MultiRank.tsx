import { memo, useCallback, useState } from "react";
import { formatBytes } from "../utils";
import { useRankSummaries } from "../stores/rankStore";

interface Props {
  /** Every rank we intend to show a slot for, including ones still loading. */
  allRanks: number[];
  currentRank: number;
  onSelectRank: (rank: number) => void;
}

const CELL_MIN_H = 14;
const CELL_MAX_H = 52;

interface HoverInfo { rank: number; x: number; y: number; }

export default function MultiRank({ allRanks, currentRank, onSelectRank }: Props) {
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const maxPeak = useRankSummaries((s) => s.maxPeak);

  const handleLeave = useCallback(() => setHover(null), []);
  const handleHover = useCallback((info: HoverInfo) => setHover(info), []);

  if (allRanks.length === 0) return null;

  // Per-rank stats for the currently-selected rank now live in the
  // sticky header (Layout.tsx); here we just render the comparison
  // strip so vertical space stays tight.
  return (
    <div>
      <div className="mr-strip" onMouseLeave={handleLeave}>
        {allRanks.map((r) => (
          <Cell
            key={r}
            rank={r}
            isSelected={r === currentRank}
            maxPeak={maxPeak}
            onSelect={onSelectRank}
            onHover={handleHover}
          />
        ))}

        {hover && <HoverTooltip rank={hover.rank} x={hover.x} />}
      </div>

      <style>{STYLES}</style>
    </div>
  );
}

interface CellProps {
  rank: number;
  isSelected: boolean;
  maxPeak: number;
  onSelect: (rank: number) => void;
  onHover: (info: HoverInfo) => void;
}

// Each Cell subscribes to only its own rank's summary. Zustand's
// selector shallow-compares, so when setSummary lands for rank R, the
// summaries map identity changes but `summaries[otherRank]` still
// returns the same reference — unrelated cells skip re-render.
const Cell = memo(function Cell({ rank, isSelected, maxPeak, onSelect, onHover }: CellProps) {
  const summary = useRankSummaries((s) => s.summaries[rank]);
  const loaded = summary !== undefined;
  // Cell height encodes *peak* memory (OOM-relevant worst moment), not
  // the snapshot's end-of-window state. Baseline (pre-window) is
  // stacked at the bottom so the "what can't be attributed" vs
  // "what new code added" split stays visible.
  const peak = loaded ? (summary.peak_bytes ?? summary.active_bytes) : 0;
  const baseline = loaded ? Math.min(summary.baseline ?? 0, peak) : 0;
  const windowDelta = loaded ? Math.max(0, peak - baseline) : 0;
  const baselineH = loaded ? (baseline / maxPeak) * CELL_MAX_H : 0;
  const peakH = loaded ? (windowDelta / maxPeak) * CELL_MAX_H : 0;

  const handleClick = useCallback(() => onSelect(rank), [onSelect, rank]);
  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const host = e.currentTarget.parentElement!.getBoundingClientRect();
      onHover({ rank, x: e.clientX - host.left, y: e.clientY - host.top });
    },
    [onHover, rank],
  );

  return (
    <button
      className={
        "mr-cell" +
        (isSelected ? " is-selected" : "") +
        (loaded ? "" : " is-pending")
      }
      onClick={handleClick}
      onMouseMove={handleMove}
      aria-label={`rank ${rank}${loaded ? "" : " (loading)"}`}
      title=""
    >
      {loaded ? (
        <>
          {/* .mr-cell uses column-reverse, so first child is bottom:
              baseline (pre-window) then peak-delta (window max above baseline). */}
          <span className="mr-cell-baseline" style={{ height: `${baselineH}px` }} />
          <span className="mr-cell-active" style={{ height: `${peakH}px` }} />
        </>
      ) : (
        <span className="mr-cell-pending" />
      )}
    </button>
  );
});

function HoverTooltip({ rank, x }: { rank: number; x: number }) {
  const summary = useRankSummaries((s) => s.summaries[rank]);
  return (
    <div
      className="mr-tooltip mono"
      style={{
        left: Math.min(x + 10, 9999),
        transform: "translateX(-50%)",
        top: -72,
      }}
    >
      <div className="display mr-tooltip-eyebrow">
        Rank {String(rank).padStart(2, "0")}
      </div>
      {summary ? (
        <>
          <div style={{ color: "var(--fg)", marginTop: 2 }}>
            peak {formatBytes(summary.peak_bytes ?? summary.active_bytes)}
            <span className="faint"> / {formatBytes(summary.total_reserved)}</span>
          </div>
          <div className="faint" style={{ fontSize: 10 }}>
            end {formatBytes(summary.active_bytes)}
          </div>
          {summary.baseline != null && summary.baseline > 0 && (
            <div className="faint" style={{ fontSize: 10, marginTop: 2 }}>
              pre-window · {formatBytes(summary.baseline)}
            </div>
          )}
        </>
      ) : (
        <div className="faint" style={{ marginTop: 2 }}>loading…</div>
      )}
    </div>
  );
}

const STYLES = `
  .mr-strip {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 14px 4px 8px;
    border-top: 1px solid var(--divider);
    min-height: ${CELL_MAX_H + 24}px;
  }
  .mr-cell {
    flex: 1;
    min-width: 6px;
    max-width: 40px;
    height: ${CELL_MAX_H}px;
    display: flex;
    flex-direction: column-reverse;
    align-items: stretch;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    position: relative;
    transition: transform 120ms var(--ease);
  }
  .mr-cell:hover { transform: translateY(-2px); }
  .mr-cell-active {
    display: block;
    background: var(--fg-dim);
    transition: background 120ms var(--ease);
  }
  .mr-cell-inactive { display: block; background: var(--border); }
  .mr-cell-baseline {
    display: block;
    background:
      repeating-linear-gradient(
        45deg,
        rgba(113,113,122,0.55) 0 2px,
        rgba(63,63,70,0.75) 2px 5px
      );
  }
  .mr-cell.is-selected .mr-cell-baseline {
    background:
      repeating-linear-gradient(
        45deg,
        rgba(217,249,157,0.45) 0 2px,
        rgba(113,113,122,0.65) 2px 5px
      );
  }
  .mr-cell-pending {
    display: block;
    flex: 1;
    background: repeating-linear-gradient(
      45deg,
      var(--border) 0 4px,
      transparent 4px 8px
    );
    opacity: 0.55;
    animation: mr-pending-pulse 1.8s ease-in-out infinite;
    min-height: ${CELL_MIN_H}px;
  }
  @keyframes mr-pending-pulse {
    0%, 100% { opacity: 0.35; }
    50%      { opacity: 0.75; }
  }
  .mr-cell:hover .mr-cell-active { background: var(--fg-muted); }
  .mr-cell.is-selected .mr-cell-active { background: var(--accent); }
  .mr-cell.is-selected::before {
    content: "";
    position: absolute;
    top: -6px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
  }
  .mr-cell.is-pending { cursor: default; }
  .mr-cell.is-pending:hover { transform: none; }

  .mr-tooltip {
    position: absolute;
    padding: 6px 10px;
    background: rgba(10,10,11,0.96);
    border: 1px solid var(--border-strong);
    font-size: 11px;
    line-height: 1.5;
    color: var(--fg-muted);
    pointer-events: none;
    white-space: nowrap;
    backdrop-filter: blur(12px);
    box-shadow: 0 6px 16px rgba(0,0,0,0.5);
    z-index: 2;
  }
  .mr-tooltip-eyebrow {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-faint);
  }

  .mr-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 64px;
  }
  .mr-stat-label {
    font-family: var(--font-display);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--fg-faint);
  }
  .mr-stat-value {
    font-family: var(--font-mono);
    font-size: 15px;
    color: var(--fg);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .mr-stat-value.hl { color: var(--accent); }
`;
