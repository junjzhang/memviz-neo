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
  const { status, phase, inFlightRanks, poolSize, error, openDirectory, openFiles } =
    useFileStore();
  const inputRef = useRef<HTMLInputElement>(null);

  if (status === "loading") {
    return <LoadingView phase={phase} inFlightRanks={inFlightRanks} poolSize={poolSize} />;
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

const PHASE_BIG: Record<string, string> = {
  idle: "PREPARING",
  compile_wasm: "COMPILING WASM",
  init_workers: "SPAWNING WORKERS",
  parsing: "PARSING SNAPSHOTS",
  done: "FINALIZING",
};

function LoadingView({
  phase,
  inFlightRanks,
  poolSize,
}: {
  phase: string;
  inFlightRanks: number[];
  poolSize: number;
}) {
  const bigLabel = PHASE_BIG[phase] || "LOADING";

  // Render N slots. N = poolSize once known, else a default so the grid
  // doesn't snap in. Align in-flight ranks into the first len slots.
  const slots = poolSize > 0 ? poolSize : 8;
  const cells: (number | null)[] = new Array(slots).fill(null);
  for (let i = 0; i < Math.min(inFlightRanks.length, slots); i++) {
    cells[i] = inFlightRanks[i];
  }

  return (
    <div className="fs-root">
      <div className="fs-stage">
        <div className="fs-eyebrow">
          {PHASE_LABEL[phase] || "Loading"}
          <span className="fs-eyebrow-dot" />
        </div>

        <h1 className="fs-phase display">{bigLabel}</h1>

        <div className="fs-worker-grid" data-slots={slots}>
          {cells.map((rank, i) => (
            <div
              key={i}
              className={"fs-worker-cell" + (rank !== null ? " is-busy" : "")}
            >
              <span className="fs-worker-idx mono">W{String(i).padStart(2, "0")}</span>
              <span className="fs-worker-rank display">
                {rank !== null ? `R${String(rank).padStart(2, "0")}` : "—"}
              </span>
            </div>
          ))}
        </div>

        <div className="fs-worker-cap mono">
          <span>{poolSize > 0 ? `${poolSize} workers` : "initializing…"}</span>
          <span className="faint">
            {inFlightRanks.length > 0 && `${inFlightRanks.length} parsing`}
          </span>
        </div>
      </div>

      {/* Decorative corner marks reused from landing */}
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

      .fs-phase {
        font-size: clamp(42px, 6vw, 84px);
        font-weight: 600;
        line-height: 0.95;
        letter-spacing: -0.02em;
        color: var(--fg);
        margin: 0 0 var(--s7);
      }

      .fs-worker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
        gap: 10px;
        max-width: 900px;
        margin-bottom: var(--s5);
      }
      .fs-worker-cell {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 14px 16px;
        border: 1px solid var(--border);
        background: var(--bg-elev);
        position: relative;
        transition: border-color 200ms var(--ease), background 200ms var(--ease);
      }
      .fs-worker-cell.is-busy {
        border-color: var(--accent);
        background: var(--accent-bg);
      }
      .fs-worker-cell.is-busy::before {
        content: "";
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 2px;
        background: var(--accent);
        animation: fs-busy-stripe 1.6s ease-in-out infinite;
      }
      @keyframes fs-busy-stripe {
        0%, 100% { opacity: 0.55; }
        50%      { opacity: 1;    }
      }
      .fs-worker-idx {
        font-size: 9px;
        letter-spacing: 0.18em;
        color: var(--fg-faint);
      }
      .fs-worker-cell.is-busy .fs-worker-idx {
        color: var(--accent-dim);
      }
      .fs-worker-rank {
        font-size: 22px;
        font-weight: 500;
        letter-spacing: -0.01em;
        color: var(--fg-dim);
        font-variant-numeric: tabular-nums;
      }
      .fs-worker-cell.is-busy .fs-worker-rank {
        color: var(--accent);
      }

      .fs-worker-cap {
        display: flex;
        justify-content: space-between;
        gap: var(--s4);
        max-width: 900px;
        padding-top: var(--s3);
        border-top: 1px solid var(--divider);
        font-size: 11px;
        color: var(--fg-faint);
        letter-spacing: 0.02em;
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
