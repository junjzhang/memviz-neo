import { useState } from "react";
import type { RankSummary } from "../types/snapshot";
import { formatBytes } from "../utils";

interface Props {
  data: RankSummary[];
  currentRank: number;
  onSelectRank: (rank: number) => void;
}

const CELL_MIN_H = 14;
const CELL_MAX_H = 52;

export default function MultiRank({ data, currentRank, onSelectRank }: Props) {
  const [hover, setHover] = useState<{ rank: RankSummary; x: number; y: number } | null>(null);

  if (!data.length) return null;

  const maxReserved = Math.max(...data.map((d) => d.total_reserved));
  const selected = data.find((d) => d.rank === currentRank) ?? data[0];

  return (
    <div>
      <HeroCard rank={selected} maxReserved={maxReserved} />

      <div
        className="mr-strip"
        onMouseLeave={() => setHover(null)}
      >
        {data.map((r) => {
          const activeH = (r.active_bytes / maxReserved) * CELL_MAX_H;
          const inactiveH = (r.inactive_bytes / maxReserved) * CELL_MAX_H;
          const totalH = Math.max(CELL_MIN_H, activeH + inactiveH);
          const isSelected = r.rank === currentRank;
          return (
            <button
              key={r.rank}
              className={"mr-cell" + (isSelected ? " is-selected" : "")}
              onClick={() => onSelectRank(r.rank)}
              onMouseMove={(e) => {
                const host = e.currentTarget.parentElement!.getBoundingClientRect();
                setHover({
                  rank: r,
                  x: e.clientX - host.left,
                  y: e.clientY - host.top,
                });
              }}
              aria-label={`rank ${r.rank}`}
              title=""
            >
              <span
                className="mr-cell-active"
                style={{ height: `${activeH}px` }}
              />
              <span
                className="mr-cell-inactive"
                style={{ height: `${inactiveH}px` }}
              />
              {totalH < CELL_MIN_H && <span className="mr-cell-placeholder" />}
            </button>
          );
        })}

        {hover && (
          <div
            className="mr-tooltip mono"
            style={{
              left: Math.min(hover.x + 10, 9999),
              transform: "translateX(-50%)",
              top: -72,
            }}
          >
            <div className="display mr-tooltip-eyebrow">
              Rank {String(hover.rank.rank).padStart(2, "0")}
            </div>
            <div style={{ color: "var(--fg)", marginTop: 2 }}>
              {formatBytes(hover.rank.total_allocated)}
              <span className="faint"> / {formatBytes(hover.rank.total_reserved)}</span>
            </div>
            <div className="faint" style={{ fontSize: 10 }}>
              {((hover.rank.total_allocated / hover.rank.total_reserved) * 100).toFixed(1)}% util
            </div>
          </div>
        )}
      </div>

      <style>{`
        .mr-hero {
          display: grid;
          grid-template-columns: auto 1fr auto auto auto auto;
          gap: 32px;
          align-items: center;
          padding: 20px 24px;
          background: var(--bg-elev);
          border: 1px solid var(--border);
          border-left: 2px solid var(--accent);
          margin-bottom: 20px;
        }
        .mr-hero-rank {
          font-family: var(--font-display);
          font-size: 28px;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--accent);
          line-height: 1;
          min-width: 72px;
        }
        .mr-hero-bar-wrap {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 160px;
        }
        .mr-hero-bar {
          height: 10px;
          background: var(--bg);
          display: flex;
          overflow: hidden;
        }
        .mr-hero-bar-active {
          background: var(--accent);
          height: 100%;
        }
        .mr-hero-bar-inactive {
          background: var(--border-strong);
          height: 100%;
        }
        .mr-hero-bar-caption {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--fg-faint);
          display: flex;
          justify-content: space-between;
        }

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
        .mr-cell-inactive {
          display: block;
          background: var(--border);
        }
        .mr-cell-placeholder {
          display: block;
          flex: 1;
          background: var(--border);
          min-height: 1px;
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
      `}</style>
    </div>
  );
}

function HeroCard({ rank, maxReserved }: { rank: RankSummary; maxReserved: number }) {
  const activePct = (rank.active_bytes / maxReserved) * 100;
  const inactivePct = (rank.inactive_bytes / maxReserved) * 100;
  const utilPct =
    rank.total_reserved > 0
      ? ((rank.total_allocated / rank.total_reserved) * 100).toFixed(1)
      : "—";

  return (
    <div className="mr-hero">
      <div className="mr-hero-rank">R{String(rank.rank).padStart(2, "0")}</div>

      <div className="mr-hero-bar-wrap">
        <div className="mr-hero-bar">
          <div className="mr-hero-bar-active" style={{ width: `${activePct}%` }} />
          <div className="mr-hero-bar-inactive" style={{ width: `${inactivePct}%` }} />
        </div>
        <div className="mr-hero-bar-caption">
          <span>allocated vs max reserved across ranks</span>
          <span>{utilPct}% util</span>
        </div>
      </div>

      <Stat label="Active" value={formatBytes(rank.active_bytes)} />
      <Stat label="Inactive" value={formatBytes(rank.inactive_bytes)} />
      <Stat label="Allocated" value={formatBytes(rank.total_allocated)} accent />
      <Stat label="Reserved" value={formatBytes(rank.total_reserved)} />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="mr-stat">
      <span className="mr-stat-label">{label}</span>
      <span className={"mr-stat-value" + (accent ? " hl" : "")}>{value}</span>
    </div>
  );
}
