<div align="center">

<img src="./docs/title.svg" alt="memviz/neo — high-performance, browser-native, multi-rank PyTorch GPU memory snapshot viewer" width="760"/>

Drop `rank*.pickle`s into the page — everything parses, computes and renders
locally. No backend, no upload, no waiting on someone else's server.

### [→ Open the app at junjzhang.github.io/memviz-neo ←](https://junjzhang.github.io/memviz-neo/)

[![License: 0BSD](https://img.shields.io/badge/license-0BSD-d9f99d?style=flat-square&labelColor=0a0a0b)](./LICENSE)
[![Stack: rust · wasm · webgl2](https://img.shields.io/badge/stack-rust%20%C2%B7%20wasm%20%C2%B7%20webgl2-d9f99d?style=flat-square&labelColor=0a0a0b)](#architecture)

![welcome page](./docs/screenshots/hero.png)

> 100% vibecoded. Not a single line written by a human. Prompts all the way down.

</div>

---

## Why

PyTorch's `torch.cuda.memory._dump_snapshot()` gives you the data; the
default viewer makes it hard to see. `memviz/neo` is a rebuild around:

1. **Multi-rank in parallel** — every rank parses in its own worker; the
   dashboard paints the moment *any* worker reports back.
2. **WebGL2 instanced strips** — 50 k+ allocs pan/zoom at 120 fps.
3. **Better lenses** — address-reuse-aware selection, cross-linked
   Memory + Segment timelines, `bytes × lifetime` flame graph, per-rank
   peak bars.

![dashboard overview](./docs/screenshots/overview.png)

## How it compares

|                                   | [pytorch/memory_viz][pv] | [desktop_memory_viz][cj] | **memviz/neo**                        |
| --------------------------------- | ------------------------ | ------------------------ | ------------------------------------- |
| Runs in                           | browser, static site     | native Rust desktop app  | **browser, static site**              |
| Install                           | — (URL)                  | `cargo build` + Python   | **— (URL)**                           |
| Pickle path                       | JS unpickler in-browser  | Python pre-extract → JSON, then Rust | **Rust → WASM with frame interning** |
| Renderer                          | SVG via D3               | eframe / egui (wgpu)     | **WebGL2 instanced**                  |
| Multi-rank view                   | pickle dropdown, one at a time | single file             | **whole run in parallel on a worker pool** |
| Views                             | Active / Segment / State / Settings | Active Memory Timeline only | **Multi-rank · Memory · Segment · Flame · Anomalies** |
| Call-stack flame (bytes × lifetime) | —                     | —                        | **✓**                                 |
| Cross-view selection linking      | —                        | —                        | **timeline ↔ segment ↔ detail panel** |
| Address-reuse-aware selection     | —                        | —                        | **keyed on `(addr, alloc_us)`**       |

### Benchmarks

12.1 MiB pickle (50 k events, 90 segments, ~18 k allocs). Framework
laptop, Intel iGPU, 120 Hz.

|                               | pytorch        | desktop_memory_viz | **memviz/neo**      |
| ----------------------------- | -------------- | ------------------ | ------------------- |
| Parse → interactive           | 163 ms         | 1588 ms            | **1040 ms**         |
| Layout + first paint          | —              | —                  | ~2100 ms            |
| JS heap after load            | —              | —                  | ~420 MiB            |
| Pan/zoom @ ~18 k allocs       | —              | —                  | **120 fps · p95 8.3 ms** |
| 8-rank wall-clock             | ~1440 ms (seq.)| —                  | **~1000 ms (parallel)** |

pytorch's parse is cheap because it defers layout until the user opens
a view; we front-load interning, pairing, top-N and IR emit so every
view switch after parse is free.

Reproduce: `node bench/{memviz,pytorch,desktop,render}.mjs` — see
[`bench/README.md`](./bench/README.md).

[pv]: https://docs.pytorch.org/memory_viz
[cj]: https://github.com/C-J-Cundy/desktop_memory_viz

## Views

- **Multi-Rank Overview** — one bar per rank, heights scale on peak, click to switch focus.
- **Memory Timeline** — WebGL2 instanced strips for every alloc. `WASD` pan/zoom X, `Shift+WASD` for Y, drag a box to zoom both, `R`/`T`+drag for rulers. X-axis toggles wall-clock μs ↔ event ordinal so dense phases stop collapsing into a smear.
- **Segment Timeline** — one row per caching-allocator segment, allocs at their in-segment offset. Pan/zoom locks to Memory Timeline; selecting an alloc expands its row 30 → 120 px.
- **Anomalies** — pending-free stalls + leak suspects, each cross-linked back to the timeline.
- **Memory Flame Graph** — call-stack rolled up by `bytes × lifetime`. Drill-in breadcrumb, hover tooltip.

![flame graph](./docs/screenshots/flamegraph.png)

## Usage

Open the site (or run locally), point **Open Directory** at a folder of
`rank*.pickle` files, pick worker count + detail level (`3k`/`10k`/`20k`/`all`).
Firefox/Safari fall back to multi-select file picker.

Nothing leaves your machine — WASM parser in a `Worker`, WebGL2 on your
GPU, zero `fetch()` beyond the bundle.

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

- **Rust + `wasm-bindgen`** pickle parser (`wasm/`). Hand-rolled streaming parser; `Rc`-shared values handle `MEMOIZE`/`BINGET` reuse without cloning frame lists.
- **Frame / stack interning** — 3.5 M frame entries collapse to ~1400 unique frames, one `u32` per event.
- **Worker pool** — parse + layout per rank in parallel, first rank back drives the dashboard.
- **Pre-packed GPU buffers** — event-mode *and* time-mode variants precomputed, X-axis toggle is one `bufferData` call.
- **Address-reuse-aware selection** — keys off `(addr, alloc_us)`, not `addr`.
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

## Release

Tag-driven. Push `main` → [`ci.yml`](./.github/workflows/ci.yml) runs
typecheck + build, no deploy. Push a `v*` tag → [`release.yml`](./.github/workflows/release.yml)
builds with `VITE_APP_VERSION=${tag}`, deploys to GitHub Pages, and
creates a GitHub Release with auto-generated notes.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

First-time setup: **Settings → Pages → Source: GitHub Actions**.

## Acknowledgements

- [pytorch/memory_viz](https://docs.pytorch.org/memory_viz) — official viewer; defined the pickle schema.
- [C-J-Cundy/desktop_memory_viz](https://github.com/C-J-Cundy/desktop_memory_viz) — desktop rework, seeded several interactions here.

## License

[0BSD](./LICENSE) — take it, ship it, no attribution required.
