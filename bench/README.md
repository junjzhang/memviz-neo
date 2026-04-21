# bench/

Reproducible parse-phase benchmarks against the prior art. The "parse
phase" for each tool covers different work, so two numbers get reported
for memviz/neo — one that's apples-to-apples with pytorch, and one for
the full pipeline we run up front.

All runs use the same snapshot file — point `SNAPSHOT` to whatever
`rank*.pickle` you want to compare on. Defaults in each script assume
`/home/jay/memory_snapshot/iteration_2_exit/rank0_memory_snapshot.pickle`.

## memviz.mjs

Runs the WASM module directly under Node — no browser, no main-thread
noise.

Two exports are measured:

- **`parse_pickle_only(bytes)`** — decodes pickle bytes into the
  `Rc<Value>` tree and touches one container. Direct analogue of
  pytorch's `unpickle`: bytes → in-memory object graph, no further
  processing.
- **`parse_intern(bytes, rank, layout_limit)`** — the full pipeline:
  decode + frame/stack interning + alloc/free pairing + top-N selection
  + IR JSON emit. The layout worker never revisits the pickle.

```bash
node bench/memviz.mjs
```

## pytorch.mjs

Times [pytorch/memory_viz][pv]'s JS pickle parser on the same snapshot.
The `unpickle` and `annotate_snapshot` functions are copied verbatim
from [MemoryViz.js][mv] (commit current at time of capture; see
`pytorch_*.js` in this folder). Both stages are reported separately and
end-to-end — `unpickle` is the bytes-to-object step, `annotate_snapshot`
walks the tree to pair allocs/frees and attach versions.

```bash
node bench/pytorch.mjs
```

## Indicative numbers

Measured on a 2-socket Intel laptop under Node v25 / Chrome v142,
Linux 6.x / wayland. Snapshot: 12.1 MiB pickle, 50 k trace events,
90 segments, 2259 blocks.

### Apples-to-apples: pickle decode only

| Tool                        | Time (avg) |
| --------------------------- | ---------- |
| pytorch `unpickle` (JS)     | ~164 ms    |
| memviz/neo `parse_pickle_only` (Rust/WASM) | **~92 ms** |

Pure pickle decode — pytorch produces a JS object tree, memviz/neo
produces an `Rc<Value>` tree. Rust/WASM with `Rc`-shared values for
`MEMOIZE`/`BINGET` is ~1.8× faster than the hand-rolled JS parser.

### Different workloads: full parse pipeline

| Tool                                   | Time (avg) | What's included |
| -------------------------------------- | ---------- | --------------- |
| pytorch `unpickle` + `annotate_snapshot` | ~163 ms  | decode + alloc/free version stamping |
| memviz/neo `parse_intern` (all)        | ~1040 ms   | decode + frame/stack interning + alloc/free pairing + top-N + IR emit |

pytorch's `annotate_snapshot` does almost nothing (~15 ms on top of
unpickle): stamp versions, normalize stream names. It defers everything
else to view-open time — when the user picks "Active Memory Timeline",
d3 walks the object tree and builds SVG rects on demand.

`parse_intern` does all the view-prep work up front:

- **Frame interning** (3.5 M `frames` entries across ~50 k events
  collapse to ~1400 unique frames + a few hundred unique stacks, one
  `u32` per event) — cuts downstream JS heap by ~20×.
- **Alloc/free pairing** with orphan-frame handling for the pre-window
  baseline (pytorch doesn't reconstruct this).
- **Top-N selection** (sort by size, truncate) so layout workers get a
  bounded work set.
- **IR JSON emit** so the main thread and layout workers don't re-walk
  the pickle ever again.

Net result: view switches are instant because there's nothing left to
compute. In pytorch you pay ~180 ms for parse, but every view switch
re-traverses the JS object tree.

### Multi-rank scaling

The single-pickle number above misses our actual win. pytorch's UI
shows one pickle at a time (dropdown to switch), no parallel parse. Our
worker pool races N ranks in parallel — an 8-rank snapshot finishes in
~1 s wall-clock instead of `8 × 180 ms = 1.44 s` sequential in pytorch.

### Render capacity

pytorch renders via SVG (d3 `<path>` / `<rect>` per allocation). We
upload pre-packed `Float32Array` strip buffers to WebGL2 once and
pan/zoom via two uniform updates per frame, so 50 k+ allocations stay
at 60 fps. [desktop_memory_viz][cj] was built specifically because the
pytorch viewer "crashes on large (~1 GB+) snapshot files" (quote from
their README).

[pv]: https://docs.pytorch.org/memory_viz
[mv]: https://github.com/pytorch/pytorch/blob/main/torch/utils/viz/MemoryViz.js
[cj]: https://github.com/C-J-Cundy/desktop_memory_viz
