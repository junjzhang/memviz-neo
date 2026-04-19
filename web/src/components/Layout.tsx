import type { ReactNode } from "react";
import { useDataStore } from "../stores/dataStore";
import { useFileStore } from "../stores/fileStore";
import type { RankSummary } from "../types/snapshot";

export default function Layout({ children }: { children: ReactNode }) {
  const currentRank = useDataStore((s) => s.currentRank);
  const summary = useDataStore((s) => s.summary);
  const loading = useFileStore((s) => s.status === "loading" && s.progress === 0);
  const hasData = useFileStore((s) => s.ranks.length > 0);
  const resetFiles = useFileStore((s) => s.reset);
  const resetData = useDataStore((s) => s.resetData);
  const handleReset = () => {
    resetFiles();
    resetData();
  };

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

        {/* Active / Inactive / Allocated / Util were moved to the
            Multi-Rank hero card — don't duplicate here. Header only
            holds identifying state (rank) and one-per-dataset config
            (allocator settings). */}
        {summary && (summary.alloc_conf !== undefined ||
          summary.expandable_segments !== undefined) && (
          <div className="app-header-stats">
            <SettingsBadge summary={summary} />
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

        .settings-badge {
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border: 1px solid var(--border);
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--fg-muted);
          cursor: help;
          letter-spacing: 0.04em;
        }
        .settings-badge:hover { color: var(--fg); border-color: var(--border-strong); }
        .settings-badge:hover .settings-popup { display: block; }
        .settings-popup {
          display: none;
          position: absolute;
          right: 0;
          top: calc(100% + 6px);
          min-width: 380px;
          max-width: 560px;
          padding: 12px 14px;
          background: rgba(10,10,11,0.98);
          border: 1px solid var(--border-strong);
          box-shadow: 0 8px 24px rgba(0,0,0,0.5);
          z-index: 20;
          white-space: normal;
          text-align: left;
        }
        .settings-popup-row { margin-bottom: 10px; }
        .settings-popup-row:last-child { margin-bottom: 0; }
        .settings-popup-label {
          font-family: var(--font-display);
          font-size: 9px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--fg-faint);
          margin-bottom: 4px;
        }
        .settings-popup-value {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--fg);
          word-break: break-all;
          line-height: 1.5;
        }
      `}</style>
    </div>
  );
}

function SettingsBadge({ summary }: { summary: RankSummary }) {
  const conf = summary.alloc_conf || "";
  const exp = summary.expandable_segments === true;
  const mss = summary.max_split_size ?? -1;
  const gc = summary.gc_threshold ?? 0;
  // Compact inline label: show the most impactful setting.
  const inline = exp ? "expandable" : conf ? "custom" : "default";
  return (
    <div className="settings-badge" title="Hover for PyTorch allocator settings">
      <span>⚙</span>
      <span style={{ opacity: 0.7 }}>{inline}</span>
      <div className="settings-popup">
        <div className="settings-popup-row">
          <div className="settings-popup-label">PYTORCH_CUDA_ALLOC_CONF</div>
          <div className="settings-popup-value">
            {conf || <span style={{ color: "var(--fg-faint)" }}>(unset)</span>}
          </div>
        </div>
        <div className="settings-popup-row">
          <div className="settings-popup-label">Expandable Segments</div>
          <div className="settings-popup-value">{exp ? "on" : "off"}</div>
        </div>
        <div className="settings-popup-row">
          <div className="settings-popup-label">max_split_size</div>
          <div className="settings-popup-value">
            {mss < 0 ? <span style={{ color: "var(--fg-faint)" }}>unlimited</span> : `${mss} MB`}
          </div>
        </div>
        <div className="settings-popup-row">
          <div className="settings-popup-label">garbage_collection_threshold</div>
          <div className="settings-popup-value">
            {gc > 0 ? gc.toFixed(2) : <span style={{ color: "var(--fg-faint)" }}>disabled</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
