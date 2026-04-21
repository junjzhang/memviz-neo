# memviz/neo

Drop a directory of PyTorch `rank*.pickle` memory snapshots into your browser.
Everything parses, computes and renders locally — **no backend, no upload**.

> 100% vibecoded. Not a single line written by a human. Prompts all the way down.

Live: <https://junjzhang.github.io/memviz-neo/>

---

## What it does

PyTorch's `torch.cuda.memory._dump_snapshot()` spits out a pickle per rank that
is great data and painful to look at. `memviz/neo` opens all ranks of a run at
once and gives you views that actually make the allocator behavior legible:

- **Multi-Rank Overview** — one sparkline per rank, peak-aligned, click to
  switch focus. Ranks are parsed in parallel; the dashboard appears the
  moment any rank lands.
- **Memory Timeline** — WebGL2 instanced strip rendering of every
  allocation's lifetime. Pan/zoom, zoom-to-box, `Shift+W/S` Y-zoom,
  `Shift+A/D` Y-pan, toggle between μs and event-ordinal X axis.
- **Segment Timeline** — the caching allocator's segments shown under the
  timeline, with top-N allocations drawn at their in-segment offset. Shares
  pan/zoom with the main timeline so they track in lockstep.
- **Anomalies** — pending-free delays (cross-stream sync hiccups) and leak
  suspects (large allocations alive at snapshot), flagged on the timeline
  and listed in a panel.
- **Memory Flame Graph** — call-stack aggregated by `bytes × lifetime` so
  the dominant memory pressure shows up where you'd read a CPU flame graph.
- **Top Allocations** — the N largest allocations with their top frame,
  click-through to the full stack.

## How to use

1. Open the site (or run locally, see below).
2. Click **Open Directory** and point it at a folder of `rank*.pickle` files
   (or use **Pick files** on browsers without the directory picker).
3. Pick a worker count and a detail level (`3k` / `10k` / `20k` / `all`
   top-N allocations kept per rank), then let it rip.

Nothing leaves your machine. The WASM parser runs in a `Worker`, rendering is
WebGL2 on your GPU.

## Architecture

```
rank*.pickle ──► Web Worker ──► Rust/WASM pickle parser ──► interned frames/stacks
                                                          │
                                                          ├─► timeline strips (Float32Array)
                                                          ├─► flame graph (call-stack rollup)
                                                          ├─► segment rows
                                                          └─► anomalies

main thread ──► Zustand stores ──► React views ──► WebGL2 instanced draw
```

- **Rust + `wasm-bindgen`** for the pickle parser (`wasm/`). No `serde_pickle`;
  a hand-rolled streaming parser with `Rc`-shared values handles PyTorch's
  heavy `MEMOIZE/BINGET` reuse without cloning megabytes of frame lists.
- **Frame/stack interning** end-to-end: a rank with 3.5M frame entries
  collapses to ~1400 unique frames and a few hundred unique stacks, one
  `u32` per event.
- **Worker pool** with per-rank parse + layout. Parse workers race; first
  rank done drives the dashboard. Configurable from 1 to
  `hardwareConcurrency`.
- **Pre-packed GPU buffers** — timeline strips ship as a single
  `Float32Array` (`t_start, t_end, y_off, height, r, g, b`) with event-mode
  and time-mode variants precomputed, so the X-axis toggle is one buffer
  swap.
- **React 19 + Zustand + AntD (dark)**, Vite + `vite-plugin-wasm`.

## Develop

Prereqs: `rustup target add wasm32-unknown-unknown`, `wasm-pack`, `pnpm`,
Node 22.

```bash
cd web
pnpm install
pnpm dev          # auto-builds wasm if pkg/ is missing
```

Other commands:

```bash
pnpm build:wasm   # wasm-pack build --release
pnpm build        # typecheck + vite build (runs build:wasm first)
```

To generate synthetic snapshots for perf work:

```bash
python scripts/gen_test_data.py --ranks 8 --events 20000 --out test_data/
```

## Deploy

`main` auto-deploys to GitHub Pages via `.github/workflows/deploy-pages.yml`
(builds WASM + Vite with `VITE_BASE=/memviz-neo/`).

## Acknowledgements

Prior art that made this project possible (and obvious to want):

- [pytorch/memory_viz](https://docs.pytorch.org/memory_viz) — the official
  snapshot viewer. Defined the pickle schema this project consumes and
  set the baseline for what "good enough" memory visualization looks like.
- [C-J-Cundy/desktop_memory_viz](https://github.com/C-J-Cundy/desktop_memory_viz)
  — a desktop-grade rework of the same viewer. Showed that the official
  tool's UX could be pushed a lot further, and seeded several of the
  interactions here.

`memviz/neo` is the browser-native, multi-rank take on the same problem.

## License

[0BSD](./LICENSE) — take it, ship it, no attribution required.
