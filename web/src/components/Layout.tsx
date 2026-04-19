import type { ReactNode } from "react";
import { useDataStore } from "../stores/dataStore";
import { useFileStore } from "../stores/fileStore";
import { formatBytes } from "../utils";

export default function Layout({ children }: { children: ReactNode }) {
  const { currentRank, summary, loading } = useDataStore();
  const hasData = useDataStore((s) => s.ranks.length > 0);
  const resetFiles = useFileStore((s) => s.reset);
  const resetData = useDataStore((s) => s.resetData);
  const handleReset = () => {
    resetFiles();
    resetData();
  };

  const utilPct = summary && summary.total_reserved > 0
    ? ((summary.total_allocated / summary.total_reserved) * 100).toFixed(1)
    : "—";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header">
        <div className="app-header-left">
          <button
            className="btn-ghost"
            onClick={handleReset}
            title="Open another directory"
            style={{
              border: "1px solid var(--border)",
              background: "transparent",
              cursor: "pointer",
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--fg-muted)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            ← Open
          </button>
          <div className="app-brand display">
            memviz<span style={{ color: "var(--accent)" }}>/neo</span>
          </div>
          {hasData && (
            <div className="rank-badge mono" title="Use Multi-Rank Overview below to switch">
              R{String(currentRank).padStart(2, "0")}
            </div>
          )}
        </div>

        {summary && (
          <div className="app-header-stats">
            <HeaderStat label="Active" value={formatBytes(summary.active_bytes)} />
            <div className="divider-v" />
            <HeaderStat label="Inactive" value={formatBytes(summary.inactive_bytes)} />
            <div className="divider-v" />
            <HeaderStat
              label="Allocated"
              value={formatBytes(summary.total_allocated)}
              sub={`/ ${formatBytes(summary.total_reserved)}`}
            />
            <div className="divider-v" />
            <HeaderStat label="Util" value={`${utilPct}%`} accent />
          </div>
        )}
      </header>

      <main>
        {loading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              paddingTop: 200,
              gap: 16,
            }}
          >
            <div className="spinner" />
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--fg-faint)", letterSpacing: "0.1em" }}
            >
              LOADING
            </div>
          </div>
        ) : (
          children
        )}
      </main>

      <style>{`
        .app-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--s5);
          padding: 20px var(--s6);
          background: var(--bg);
          border-bottom: 1px solid var(--divider);
          position: sticky;
          top: 0;
          z-index: 10;
          backdrop-filter: blur(8px);
        }
        .app-header-left {
          display: flex;
          align-items: center;
          gap: var(--s4);
        }
        .app-brand {
          font-size: 18px;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--fg);
        }
        .rank-badge {
          display: inline-flex;
          align-items: center;
          padding: 4px 10px;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.1em;
          color: var(--accent);
          border: 1px solid var(--border-strong);
          background: var(--accent-bg);
        }
        .app-header-stats {
          display: flex;
          align-items: stretch;
          gap: var(--s5);
        }
        .hs-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .hs-label {
          font-family: var(--font-display);
          font-size: 9px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--fg-faint);
        }
        .hs-value {
          font-family: var(--font-mono);
          font-size: 14px;
          color: var(--fg);
          font-variant-numeric: tabular-nums;
        }
        .hs-value.hl { color: var(--accent); }
        .hs-sub { font-family: var(--font-mono); font-size: 10px; color: var(--fg-faint); margin-left: 4px; }
      `}</style>
    </div>
  );
}

function HeaderStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="hs-item">
      <div className="hs-label">{label}</div>
      <div className={"hs-value" + (accent ? " hl" : "")}>
        {value}
        {sub && <span className="hs-sub">{sub}</span>}
      </div>
    </div>
  );
}
