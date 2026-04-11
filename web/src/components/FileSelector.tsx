import { useRef } from "react";
import { useFileStore } from "../stores/fileStore";

const hasDirectoryPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

const PHASE_LABEL: Record<string, string> = {
  idle: "Preparing",
  compile_wasm: "Compiling WASM",
  init_workers: "Spawning workers",
  parsing: "Parsing snapshots",
  done: "Finishing up",
};

export default function FileSelector() {
  const { status, phase, completedCount, inFlightCount, totalCount, error, fileNames, openDirectory, openFiles } =
    useFileStore();
  const inputRef = useRef<HTMLInputElement>(null);

  if (status === "loading") {
    const label = PHASE_LABEL[phase] || "Loading";
    const progressPct =
      totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
    // Show currently-active file (first in-flight). Fallback to last finished.
    const activeIdx = Math.min(completedCount, fileNames.length - 1);
    const currentFile = fileNames[activeIdx] ?? "";

    return (
      <div className="fs-root">
        <div className="fs-stage">
          <div className="fs-eyebrow">
            {label}
            <span className="fs-eyebrow-dot" />
          </div>
          <div className="fs-bignum display">
            {String(completedCount).padStart(2, "0")}
            <span className="fs-bignum-unit"> / {String(totalCount).padStart(2, "0")}</span>
          </div>
          <div className="fs-progress-track">
            <div className="fs-progress-bar" style={{ width: `${progressPct}%` }} />
            <div className="fs-progress-indeterminate" />
          </div>
          <div className="fs-loading-meta mono">
            <span>{currentFile || "\u00a0"}</span>
            {inFlightCount > 0 && (
              <span className="faint">
                {inFlightCount} in flight
              </span>
            )}
          </div>
        </div>
        <FsStyle />
      </div>
    );
  }

  return (
    <div className="fs-root">
      <div className="fs-stage">
        <div className="fs-eyebrow">PyTorch · GPU Memory · Frontend-Only</div>
        <h1 className="fs-title display">
          memviz
          <span className="fs-title-neo">/neo</span>
        </h1>
        <p className="fs-lede">
          Drop in a directory of <span className="mono hl">rank*.pickle</span> snapshots.
          Everything is parsed, computed and rendered locally in your browser —
          <span className="muted"> zero backend, zero upload.</span>
        </p>

        <div className="fs-actions">
          {hasDirectoryPicker && (
            <button className="btn btn-primary fs-btn" onClick={openDirectory}>
              Open Directory →
            </button>
          )}
          <button className="btn fs-btn" onClick={() => inputRef.current?.click()}>
            {hasDirectoryPicker ? "Or pick .pickle files" : "Select .pickle files"}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pickle"
            style={{ display: "none" }}
            onChange={(e) => e.target.files && openFiles(e.target.files)}
          />
        </div>

        {error && <div className="fs-error mono">! {error}</div>}

        <div className="fs-footprint">
          <div className="fs-fp-item">
            <span className="fs-fp-k">runtime</span>
            <span className="fs-fp-v mono">rust · wasm</span>
          </div>
          <div className="fs-fp-item">
            <span className="fs-fp-k">render</span>
            <span className="fs-fp-v mono">webgl2 · instanced</span>
          </div>
          <div className="fs-fp-item">
            <span className="fs-fp-k">capacity</span>
            <span className="fs-fp-v mono">128 ranks · 1GB each</span>
          </div>
        </div>
      </div>

      {/* Decorative corner marks */}
      <div className="fs-mark fs-mark-tl" />
      <div className="fs-mark fs-mark-tr" />
      <div className="fs-mark fs-mark-bl" />
      <div className="fs-mark fs-mark-br" />

      <FsStyle />
    </div>
  );
}

function FsStyle() {
  return (
    <style>{`
      .fs-root {
        min-height: 100vh;
        background: var(--bg);
        position: relative;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        padding: 0 var(--s9);
        overflow: hidden;
      }
      .fs-root::before {
        content: "";
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(to right, var(--divider) 1px, transparent 1px),
          linear-gradient(to bottom, var(--divider) 1px, transparent 1px);
        background-size: 64px 64px;
        mask-image: radial-gradient(ellipse at 30% 40%, #000 0%, transparent 70%);
        -webkit-mask-image: radial-gradient(ellipse at 30% 40%, #000 0%, transparent 70%);
        pointer-events: none;
      }
      .fs-stage {
        position: relative;
        max-width: 760px;
        z-index: 1;
      }
      .fs-eyebrow {
        font-family: var(--font-display);
        font-size: 11px;
        letter-spacing: 0.24em;
        text-transform: uppercase;
        color: var(--fg-faint);
        margin-bottom: var(--s5);
      }
      .fs-title {
        font-size: clamp(72px, 11vw, 148px);
        font-weight: 700;
        line-height: 0.88;
        letter-spacing: -0.05em;
        color: var(--fg);
        margin: 0 0 var(--s5);
      }
      .fs-title-neo {
        color: var(--accent);
        font-weight: 400;
      }
      .fs-lede {
        font-family: var(--font-sans);
        font-size: 17px;
        line-height: 1.55;
        color: var(--fg-muted);
        max-width: 560px;
        margin: 0 0 var(--s7);
      }
      .fs-actions {
        display: flex;
        gap: var(--s3);
        margin-bottom: var(--s7);
        flex-wrap: wrap;
      }
      .fs-btn { padding: 14px 26px; font-size: 14px; }
      .fs-error {
        color: var(--red);
        font-size: 12px;
        margin-bottom: var(--s6);
        padding: var(--s3);
        border-left: 2px solid var(--red);
        background: rgba(248, 113, 113, 0.05);
      }
      .fs-footprint {
        display: flex;
        gap: var(--s7);
        padding-top: var(--s5);
        border-top: 1px solid var(--divider);
      }
      .fs-fp-item { display: flex; flex-direction: column; gap: 4px; }
      .fs-fp-k {
        font-family: var(--font-display);
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--fg-faint);
      }
      .fs-fp-v { font-size: 12px; color: var(--fg); }

      /* Loading view */
      .fs-eyebrow-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-left: 10px;
        vertical-align: 1px;
        background: var(--accent);
        animation: fs-pulse 1.1s ease-in-out infinite;
      }
      @keyframes fs-pulse {
        0%, 100% { opacity: 0.25; transform: scale(0.8); }
        50%      { opacity: 1; transform: scale(1.2); }
      }

      .fs-bignum {
        font-size: clamp(120px, 16vw, 220px);
        font-weight: 500;
        line-height: 0.85;
        color: var(--fg);
        font-variant-numeric: tabular-nums;
        margin: var(--s2) 0 var(--s5);
      }
      .fs-bignum-unit {
        font-size: 0.28em;
        color: var(--fg-faint);
        margin-left: 0.2em;
        vertical-align: 0.5em;
        font-weight: 400;
      }
      .fs-progress-track {
        position: relative;
        height: 2px;
        background: var(--border);
        width: 560px;
        max-width: 100%;
        overflow: hidden;
      }
      .fs-progress-bar {
        position: absolute;
        top: 0; left: 0;
        height: 100%;
        background: var(--accent);
        transition: width 300ms var(--ease);
      }
      /* Indeterminate sweep — always running while loading, so the bar
         never appears frozen even when completed=0. */
      .fs-progress-indeterminate {
        position: absolute;
        top: 0;
        height: 100%;
        width: 30%;
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(217, 249, 157, 0.45) 50%,
          transparent 100%
        );
        animation: fs-sweep 1.8s ease-in-out infinite;
      }
      @keyframes fs-sweep {
        0%   { left: -30%; }
        100% { left: 100%; }
      }
      .fs-loading-meta {
        margin-top: var(--s3);
        font-size: 11px;
        color: var(--fg-faint);
        display: flex;
        justify-content: space-between;
        gap: var(--s4);
        max-width: 560px;
        white-space: nowrap;
        overflow: hidden;
      }
      .fs-loading-meta > span:first-child {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* Corner marks */
      .fs-mark {
        position: absolute;
        width: 20px;
        height: 20px;
        border-color: var(--fg-dim);
        border-style: solid;
      }
      .fs-mark-tl { top: 32px; left: 32px; border-width: 1px 0 0 1px; }
      .fs-mark-tr { top: 32px; right: 32px; border-width: 1px 1px 0 0; }
      .fs-mark-bl { bottom: 32px; left: 32px; border-width: 0 0 1px 1px; }
      .fs-mark-br { bottom: 32px; right: 32px; border-width: 0 1px 1px 0; }
    `}</style>
  );
}
