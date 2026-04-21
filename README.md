<div align="center">

# memviz/neo

**Browser-native, multi-rank PyTorch GPU memory snapshot viewer.**
Drop `rank*.pickle`s into the page — everything parses, computes and renders
locally. No backend, no upload, no waiting on someone else's server.

[![Live demo](https://img.shields.io/badge/live%20demo-junjzhang.github.io-d9f99d?style=flat-square&labelColor=0a0a0b)](https://junjzhang.github.io/memviz-neo/)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-d9f99d?style=flat-square&labelColor=0a0a0b)](./LICENSE)
[![Stack: rust · wasm · webgl2](https://img.shields.io/badge/stack-rust%20%C2%B7%20wasm%20%C2%B7%20webgl2-d9f99d?style=flat-square&labelColor=0a0a0b)](#architecture)

![welcome page](./docs/screenshots/hero.png)

> 100% vibecoded. Not a single line written by a human. Prompts all the way down.

</div>

---

## Why

PyTorch's `torch.cuda.memory._dump_snapshot()` spits out a pickle per rank.
The data is gold; the default viewer makes it hard to see. `memviz/neo` is a
rebuild around three ideas:

1. **Multi-rank at once.** Parse every rank of the run in parallel in the
   browser; the dashboard shows the first one that finishes and the rest
   stream in behind it.
2. **WebGL2 for the plots.** Every allocation's lifetime is an instanced
   strip — 50 k+ allocs pan/zoom at 60 fps without breaking a sweat.
3. **Same pickle, better lenses.** Address-reuse-aware selection,
   cross-linked Memory + Segment timelines, call-stack flame graph weighted
   by `bytes × lifetime`, per-rank peak bars.

![dashboard overview](./docs/screenshots/overview.png)

## Views at a glance

<table>
<tr>
<td width="60%" valign="top">

**Multi-Rank Overview** — one bar per rank, heights scale on the peak
(not end-of-window), click to switch focus. Parsing is truly parallel, so on
a 128-rank run the dashboard paints the moment *any* worker reports back.

**Memory Timeline** — WebGL2 instanced strip rendering of every allocation
in the top-N. `WASD` to pan/zoom X, `Shift+WASD` for Y, drag a box to zoom
both axes, `R`/`T`+drag for memory/time rulers, double-click to reset.
X-axis toggles between wall-clock μs and alloc/free event ordinal so dense
training phases stretch out instead of collapsing into a smear.

**Segment Timeline** — one row per caching-allocator segment, allocs drawn
at their in-segment offset. Pan/zoom locks to the Memory Timeline. Selecting
an alloc expands its segment row from 30 → 120 px so small allocs inside
big segments become actually readable.

**Memory Flame Graph** — call-stack rolled up by `bytes × lifetime`, so
the paths that hold memory longest dominate the view. Drill-in breadcrumb,
hover tooltip, all in the same six-hue theme palette as the rest of the
dashboard.

**Anomalies** — flags pending-free stalls (`free_requested` but not
`free_completed`, usually a cross-stream sync hiccup) and leak suspects
(large long-lived allocs still alive at snapshot). Each anomaly cross-links
back to the timeline for a zoom-to-spot focus.

</td>
<td width="40%" valign="top">

![flame graph](./docs/screenshots/flamegraph.png)

</td>
</tr>
</table>

## Usage

1. Open the site, or run locally (see below).
2. Click **Open Directory** and point it at a folder of `rank*.pickle` files.
   Firefox/Safari fall back to **Pick .pickle files** (multi-select).
3. Pick a worker count and a detail level (`3k` / `10k` / `20k` / `all`
   top-N allocations kept per rank), then let it rip.

Nothing leaves your machine. The WASM parser runs in a `Worker`, rendering
is WebGL2 on your GPU, and there is no `fetch()` that isn't the bundle
itself.

## Architecture

```
rank*.pickle ──► Parse worker ──► Rust/WASM pickle parser ──► interned frames / stacks
                                                            │
                                                            ├─► timeline strips (Float32Array, event + time variants)
                                                            ├─► segment rows (per-segment alloc buckets)
                                                            ├─► flame graph (stack-weighted prefix trie)
                                                            └─► anomalies (leak + pending-free flags)

main thread ──► Zustand stores ──► React views ──► WebGL2 instanced draw
```

- **Rust + `wasm-bindgen`** for the pickle parser (`wasm/`). No
  `serde_pickle`; a hand-rolled streaming parser with `Rc`-shared values
  handles PyTorch's heavy `MEMOIZE` / `BINGET` reuse without cloning
  megabytes of frame lists.
- **Frame / stack interning** end-to-end: a rank with 3.5 M frame entries
  collapses to ~1400 unique frames and a few hundred unique stacks, one
  `u32` per event.
- **Worker pool**, per-rank parse + layout in parallel. Parse workers race;
  first rank back drives the dashboard. Configurable from 1 to
  `hardwareConcurrency`.
- **Pre-packed GPU buffers** — timeline strips ship as a single
  `Float32Array` with event-mode *and* time-mode variants precomputed, so
  the X-axis toggle is one `bufferData` call.
- **Address-reuse-aware selection** — keys off `(addr, alloc_us)`, not
  `addr` alone, so clicking a block doesn't pick up a *different* alloc
  that happened to land at the same GPU address later.
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

Synthetic snapshots for perf work:

```bash
python scripts/gen_test_data.py --ranks 8 --events 20000 --out test_data/
```

## Deploy

`main` auto-deploys to GitHub Pages via
[`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml)
(builds WASM + Vite with `VITE_BASE=/memviz-neo/`). First-time setup only
needs **Settings → Pages → Source: GitHub Actions**.

## Acknowledgements

Prior art that made this project possible (and obvious to want):

- [pytorch/memory_viz](https://docs.pytorch.org/memory_viz) — the official
  snapshot viewer. Defined the pickle schema this project consumes and set
  the baseline for what "good enough" memory visualization looks like.
- [C-J-Cundy/desktop_memory_viz](https://github.com/C-J-Cundy/desktop_memory_viz)
  — a desktop-grade rework of the same viewer. Showed that the official
  tool's UX could be pushed a lot further, and seeded several of the
  interactions here.

`memviz/neo` is the browser-native, multi-rank take on the same problem.

## License

[0BSD](./LICENSE) — take it, ship it, no attribution required.
