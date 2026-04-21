import { useEffect, useMemo, useRef } from "react";
import { useFileStore, WORKER_COUNT_MAX, LAYOUT_LIMIT_OPTIONS } from "../stores/fileStore";

/**
 * Track pointer position (normalised to −1..1) on CSS custom properties
 * so the decorative blobs can follow the cursor with pure CSS. Scoped to
 * the FileSelector mount — as soon as the app loads data, the listener
 * goes away.
 */
function usePointerParallax() {
  useEffect(() => {
    const onMove = (e: MouseEvent | PointerEvent) => {
      const x = (e.clientX / window.innerWidth - 0.5) * 2;
      const y = (e.clientY / window.innerHeight - 0.5) * 2;
      const s = document.documentElement.style;
      s.setProperty("--fs-mx", x.toFixed(3));
      s.setProperty("--fs-my", y.toFixed(3));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
}

const hasDirectoryPicker = typeof window !== "undefined" && "showDirectoryPicker" in window;

const PHASE_LABEL: Record<string, string> = {
  idle: "Preparing",
  compile_wasm: "Compiling WASM",
  init_workers: "Spawning workers",
  parsing: "Parsing snapshots",
  done: "Finishing up",
};

export default function FileSelector() {
  const {
    status, phase, inFlightRanks, poolSize, error,
    openDirectory, openFiles,
    workerCount, setWorkerCount,
    layoutLimit, setLayoutLimit,
  } = useFileStore();
  const inputRef = useRef<HTMLInputElement>(null);
  usePointerParallax();

  // Pill values: 1, 2, 4, 8, detected max — deduped and capped.
  const workerOptions = useMemo(() => {
    const set = new Set<number>([1, 2, 4, 8, WORKER_COUNT_MAX]);
    return [...set].filter((n) => n <= WORKER_COUNT_MAX).sort((a, b) => a - b);
  }, []);

  if (status === "loading") {
    return <LoadingView phase={phase} inFlightRanks={inFlightRanks} poolSize={poolSize} />;
  }

  return (
    <div className="fs-root">
      <div className="fs-stage">
        <div className="fs-eyebrow">PyTorch · GPU Memory · Frontend-Only</div>
        <h1 className="fs-title display" aria-label="memviz/neo">
          <span className="fs-title-track">
            {Array.from({ length: 3 }).map((_, i) => (
              <span className="fs-title-text" key={i} aria-hidden={i > 0 ? true : undefined}>
                memviz<span className="fs-title-neo">/neo</span>
              </span>
            ))}
          </span>
        </h1>
        <p className="fs-lede">
          Drop in a directory of <span className="mono hl">rank*.pickle</span> snapshots.
          Everything is parsed, computed and rendered locally in your browser —
          <span className="muted"> zero backend, zero upload.</span>
        </p>

        <div className="fs-config">
          <span className="fs-config-k">Workers</span>
          <div className="fs-pills">
            {workerOptions.map((n) => (
              <button
                key={n}
                className={"fs-pill mono" + (workerCount === n ? " is-active" : "")}
                onClick={() => setWorkerCount(n)}
                aria-pressed={workerCount === n}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="fs-config-hint mono faint">
            detected {WORKER_COUNT_MAX} core{WORKER_COUNT_MAX === 1 ? "" : "s"}
          </span>
        </div>

        <div className="fs-config">
          <span className="fs-config-k">Detail</span>
          <div className="fs-pills">
            {LAYOUT_LIMIT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={"fs-pill mono" + (layoutLimit === opt.value ? " is-active" : "")}
                onClick={() => setLayoutLimit(opt.value)}
                aria-pressed={layoutLimit === opt.value}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="fs-config-hint mono faint">
            top-N allocations kept per rank
          </span>
        </div>

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
            <span className="fs-fp-k">scope</span>
            <span className="fs-fp-v mono">multi-rank · parallel parse</span>
          </div>
        </div>
      </div>

      {/* Blurred color blobs instead of a grid — big soft washes of the
          brand palette bleeding behind the stage. */}
      <div className="fs-blob fs-blob-a" />
      <div className="fs-blob fs-blob-b" />
      <div className="fs-blob fs-blob-c" />

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

      <div className="fs-blob fs-blob-a" />
      <div className="fs-blob fs-blob-b" />
      <div className="fs-blob fs-blob-c" />

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
        padding: 0 clamp(24px, 5vw, 72px);
        overflow: hidden;
      }
      /* Soft accent blobs float behind everything; heavy blur + screen
         blend so they read as light bleeding through glass, not as
         opaque discs. */
      .fs-blob {
        position: absolute;
        border-radius: 50%;
        filter: blur(160px) saturate(1.2);
        mix-blend-mode: screen;
        pointer-events: none;
        z-index: 0;
      }
      /* Each blob parallaxes against the cursor by a different factor
         so the scene gains fake depth — the closer blob (larger drift)
         reads as nearer. Transition smooths out 60Hz pointer jitter. */
      .fs-blob-a {
        top: -10vw; left: -12vw;
        width: 52vw; height: 52vw;
        background: var(--accent);
        opacity: 0.38;
        transform: translate3d(
          calc(var(--fs-mx, 0) * 140px),
          calc(var(--fs-my, 0) * 100px),
          0);
        transition: transform 320ms cubic-bezier(.2,.7,.2,1);
      }
      .fs-blob-b {
        bottom: -16vw; right: -14vw;
        width: 48vw; height: 48vw;
        background: #f472b6; /* pink from the flamegraph palette */
        opacity: 0.30;
        transform: translate3d(
          calc(var(--fs-mx, 0) * -180px),
          calc(var(--fs-my, 0) * -140px),
          0);
        transition: transform 380ms cubic-bezier(.2,.7,.2,1);
      }
      .fs-blob-c {
        top: 28%; left: 46%;
        width: 40vw; height: 40vw;
        background: #c4b5fd; /* violet */
        opacity: 0.22;
        transform: translate3d(
          calc(var(--fs-mx, 0) * 260px),
          calc(var(--fs-my, 0) * 200px),
          0);
        transition: transform 240ms cubic-bezier(.2,.7,.2,1);
      }
      @media (prefers-reduced-motion: reduce) {
        .fs-blob { transition: none; transform: none !important; }
      }
      .fs-stage {
        position: relative;
        z-index: 1;
        width: 100%;
      }
      .fs-eyebrow {
        font-family: var(--font-display);
        font-size: 12px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--fg);
        text-shadow: 0 1px 1px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.55);
        margin-bottom: var(--s4);
      }
      /* Oversized display type that marquees left so "memviz/neo neo"
         trails across the viewport — graphic-design poster vibe, and
         both words get their moment on screen. */
      .fs-title {
        font-size: clamp(140px, 24vw, 380px);
        font-weight: 700;
        line-height: 0.82;
        letter-spacing: -0.06em;
        color: var(--fg);
        margin: 0 0 var(--s5);
        overflow: hidden;
      }
      .fs-title-track {
        display: inline-flex;
        animation: fs-marquee 28s linear infinite;
        will-change: transform;
        transform: translateZ(0);
      }
      /* Every copy owns an equal-sized trailing space (no flex gap), so
         shifting by exactly 1/N of the track width lines the next copy
         up pixel-perfect with the previous one and the loop has no jump. */
      .fs-title-text {
        white-space: nowrap;
        padding-right: 0.35em;
      }
      .fs-title-neo {
        color: var(--accent);
        font-weight: 400;
      }
      @keyframes fs-marquee {
        from { transform: translate3d(0, 0, 0); }
        to   { transform: translate3d(calc(-100% / 3), 0, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .fs-title-track { animation: none; }
      }
      .fs-lede {
        font-family: var(--font-sans);
        font-size: clamp(18px, 1.4vw, 22px);
        line-height: 1.5;
        color: var(--fg);
        text-shadow: 0 1px 2px rgba(0,0,0,0.55);
        max-width: 620px;
        margin: 0 0 var(--s7);
      }
      .fs-config {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: var(--s5);
        flex-wrap: wrap;
      }
      .fs-config-k {
        font-family: var(--font-display);
        font-size: 10px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--fg-muted);
        text-shadow: 0 1px 1px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.55);
      }
      .fs-config-hint {
        font-size: 11px;
        letter-spacing: 0.06em;
        color: var(--fg-muted);
        text-shadow: 0 1px 1px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.55);
      }
      .fs-pills {
        display: inline-flex;
        gap: 4px;
      }
      .fs-pill {
        min-width: 32px;
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 500;
        color: var(--fg-muted);
        background: rgba(17,17,19,0.4);
        border: 1px solid rgba(42,42,47,0.6);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        cursor: pointer;
        transition: all 120ms var(--ease);
      }
      .fs-pill:hover {
        border-color: var(--fg-faint);
        color: var(--fg);
      }
      .fs-pill.is-active {
        color: var(--bg);
        background: var(--accent);
        border-color: var(--accent);
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
      }
      .fs-fp-item { display: flex; flex-direction: column; gap: 4px; }
      .fs-fp-k {
        font-family: var(--font-display);
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--fg-faint);
      }
      .fs-fp-v {
        font-size: 12px;
        color: var(--fg);
        text-shadow: 0 1px 2px rgba(0,0,0,0.55);
      }

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
        font-size: clamp(96px, 14vw, 220px);
        font-weight: 700;
        line-height: 0.86;
        letter-spacing: -0.04em;
        color: var(--fg);
        margin: 0 0 var(--s7);
        white-space: nowrap;
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
        border: 1px solid rgba(42,42,47,0.6);
        background: rgba(17,17,19,0.4);
        backdrop-filter: blur(14px) saturate(1.1);
        -webkit-backdrop-filter: blur(14px) saturate(1.1);
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
        font-size: 11px;
        color: var(--fg-faint);
        letter-spacing: 0.02em;
      }
    `}</style>
  );
}
