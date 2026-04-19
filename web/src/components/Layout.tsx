import type { ReactNode } from "react";
import { useDataStore } from "../stores/dataStore";
import { useFileStore } from "../stores/fileStore";

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
            Multi-Rank hero card — don't duplicate here. Header holds
            identifying state (rank) and one-per-dataset config
            (allocator settings) flat so users can scan them at a
            glance. */}
        {summary && summary.alloc_conf !== undefined && (
          <div className="app-header-stats">
            <AllocStat
              label="Expandable"
              value={summary.expandable_segments ? "on" : "off"}
              accent={summary.expandable_segments === true}
            />
            <div className="divider-v" />
            <AllocStat
              label="Max Split"
              value={
                summary.max_split_size !== undefined && summary.max_split_size >= 0
                  ? `${summary.max_split_size} MB`
                  : "unlimited"
              }
              dim={summary.max_split_size === undefined || summary.max_split_size < 0}
            />
            <div className="divider-v" />
            <AllocStat
              label="GC Threshold"
              value={
                summary.gc_threshold && summary.gc_threshold > 0
                  ? summary.gc_threshold.toFixed(2)
                  : "off"
              }
              dim={!summary.gc_threshold || summary.gc_threshold <= 0}
            />
            <div className="divider-v" />
            <AllocConfStat value={summary.alloc_conf || ""} />
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

function AllocStat({
  label,
  value,
  accent,
  dim,
}: {
  label: string;
  value: string;
  accent?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="hs-item">
      <div className="hs-label">{label}</div>
      <div
        className={"hs-value" + (accent ? " hl" : "")}
        style={dim ? { color: "var(--fg-faint)" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function AllocConfStat({ value }: { value: string }) {
  const display = value || "(unset)";
  // Truncate long PYTORCH_CUDA_ALLOC_CONF strings; full text available
  // via native tooltip.
  const MAX = 40;
  const shown = display.length > MAX ? display.slice(0, MAX - 1) + "…" : display;
  return (
    <div className="hs-item" title={display}>
      <div className="hs-label">ALLOC_CONF</div>
      <div
        className="hs-value"
        style={{ fontSize: 12, color: value ? "var(--fg)" : "var(--fg-faint)" }}
      >
        {shown}
      </div>
    </div>
  );
}
