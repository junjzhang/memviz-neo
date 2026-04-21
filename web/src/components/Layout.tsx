import type { ReactNode } from "react";
import { useDataStore } from "../stores/dataStore";
import { useFileStore } from "../stores/fileStore";
import { useRankSummaries, summaryMetrics } from "../stores/rankStore";
import { formatBytes } from "../utils";

export default function Layout({ children }: { children: ReactNode }) {
  const currentRank = useDataStore((s) => s.currentRank);
  const summary = useDataStore((s) => s.summary);
  const loading = useFileStore((s) => s.status === "loading" && s.progress === 0);
  const hasData = useFileStore((s) => s.ranks.length > 0);
  const xAxisMode = useDataStore((s) => s.xAxisMode);
  const setXAxisMode = useDataStore((s) => s.setXAxisMode);
  const resetFiles = useFileStore((s) => s.reset);
  const resetData = useDataStore((s) => s.resetData);
  const liveSummary = useRankSummaries((s) => s.summaries[currentRank]);
  const handleReset = () => {
    resetFiles();
    resetData();
  };

  const { peak, reserved, baseline } = summaryMetrics(liveSummary);
  const util = reserved > 0 ? ((peak / reserved) * 100).toFixed(0) : "—";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header className="app-header">
        <div className="app-header-left">
          <button
            className="app-header-open"
            onClick={handleReset}
            title="Open another directory"
          >
            ← Open
          </button>
          {hasData && (
            <div className="axis-toggle mono" role="group" aria-label="Timeline X axis">
              <button
                className={xAxisMode === "time" ? "is-active" : ""}
                onClick={() => setXAxisMode("time")}
                title="X axis = absolute microseconds"
              >
                time
              </button>
              <button
                className={xAxisMode === "event" ? "is-active" : ""}
                onClick={() => setXAxisMode("event")}
                title="X axis = alloc/free event ordinal — dense phases stretch, idle gaps collapse"
              >
                event
              </button>
            </div>
          )}
        </div>

        {/* Right cluster: inline stats, mono, one line. No labels above
            values — each fact is "key value" so a glance tells you
            everything without scanning a grid. */}
        <div className="app-header-right mono">
          {hasData && (
            <span className="hx hx-rank" title="Use Multi-Rank Overview below to switch">
              <span className="hx-k">rank</span>
              <span className="hx-v hl">R{String(currentRank).padStart(2, "0")}</span>
            </span>
          )}
          {liveSummary && (
            <>
              <span className="hx">
                <span className="hx-k">peak</span>
                <span className="hx-v hl">{formatBytes(peak)}</span>
              </span>
              <span className="hx">
                <span className="hx-k">reserved</span>
                <span className="hx-v">{formatBytes(reserved)}</span>
                <span className="hx-sub">{util}%</span>
              </span>
              {baseline > 0 && (
                <span className="hx" title="pre-window baseline — allocations alive before the ring buffer window began">
                  <span className="hx-k">baseline</span>
                  <span className="hx-v">{formatBytes(baseline)}</span>
                </span>
              )}
            </>
          )}
          {summary && summary.alloc_conf !== undefined && (
            <>
              <span className="hx-sep">·</span>
              <span className={"hx" + (summary.expandable_segments ? " hx-on" : "")}>
                <span className="hx-k">expandable</span>
                <span className="hx-v">{summary.expandable_segments ? "on" : "off"}</span>
              </span>
              <span className="hx">
                <span className="hx-k">split</span>
                <span className="hx-v">
                  {summary.max_split_size !== undefined && summary.max_split_size >= 0
                    ? `${summary.max_split_size}MB`
                    : "∞"}
                </span>
              </span>
              <span className="hx">
                <span className="hx-k">gc</span>
                <span className="hx-v">
                  {summary.gc_threshold && summary.gc_threshold > 0
                    ? summary.gc_threshold.toFixed(2)
                    : "off"}
                </span>
              </span>
              {summary.alloc_conf && (
                <span className="hx hx-conf" title={summary.alloc_conf}>
                  <span className="hx-k">conf</span>
                  <span className="hx-v">
                    {summary.alloc_conf.length > 24
                      ? summary.alloc_conf.slice(0, 23) + "…"
                      : summary.alloc_conf}
                  </span>
                </span>
              )}
            </>
          )}
          <span className="hx-sep">·</span>
          <span className="hx" title="Build version">
            <span className="hx-k">ver</span>
            <span className="hx-v">{__APP_VERSION__}</span>
          </span>
        </div>
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
          align-items: stretch;
          padding: 0 var(--s6);
          background: rgba(10,10,11,0.55);
          border-bottom: 1px solid rgba(42,42,47,0.6);
          position: sticky;
          top: 0;
          z-index: 10;
          backdrop-filter: blur(18px) saturate(1.15);
          -webkit-backdrop-filter: blur(18px) saturate(1.15);
          min-height: 44px;
        }
        /* Left = interactive controls: buttons + toggle. Distinct by
           padding, border chrome, and a hard right rule that separates
           it from the readout strip. */
        .app-header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 0 0 auto;
          padding-right: 16px;
          border-right: 1px solid var(--border);
        }
        /* Right = passive readout: mono chips, no hit targets, subtle
           inset background so the eye reads it as a status strip. */
        .app-header-right {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
          justify-content: flex-end;
          padding-left: 16px;
          font-size: 12px;
          color: var(--fg-muted);
          background: rgba(255,255,255,0.015);
          flex: 1 1 auto;
        }
        .app-header-open {
          appearance: none;
          border: 1px solid var(--border);
          background: transparent;
          cursor: pointer;
          padding: 3px 8px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--fg-muted);
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .app-header-open:hover { color: var(--fg); border-color: var(--border-strong); }
        .axis-toggle {
          display: inline-flex;
          align-items: stretch;
          border: 1px solid var(--border);
          height: 22px;
        }
        .axis-toggle button {
          appearance: none;
          background: transparent;
          border: none;
          padding: 0 8px;
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--fg-faint);
          cursor: pointer;
        }
        .axis-toggle button:hover { color: var(--fg); }
        .axis-toggle button.is-active {
          background: var(--accent-bg);
          color: var(--accent);
        }
        .axis-toggle button + button { border-left: 1px solid var(--border); }

        .hx {
          display: inline-flex;
          align-items: baseline;
          gap: 4px;
          white-space: nowrap;
        }
        .hx-k {
          font-size: 10px;
          letter-spacing: 0.06em;
          color: var(--fg-faint);
          text-transform: uppercase;
        }
        .hx-v {
          font-size: 12px;
          color: var(--fg);
          font-variant-numeric: tabular-nums;
        }
        .hx-v.hl { color: var(--accent); font-size: 13px; }
        .hx-sub { font-size: 10px; color: var(--fg-faint); }
        .hx-sep { color: var(--border-strong); user-select: none; }
        .hx-on .hx-v { color: var(--accent); }
      `}</style>
    </div>
  );
}
