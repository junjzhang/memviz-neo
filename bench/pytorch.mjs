// Benchmark pytorch/memory_viz's JS pickle parser + post-processing on
// the same snapshot our WASM parser chews through in memviz.mjs. Both
// functions (unpickle, annotate_snapshot) are copied verbatim from
// https://github.com/pytorch/pytorch/blob/main/torch/utils/viz/MemoryViz.js
// — see pytorch_*.js in this directory.
//
// Why two stages? `unpickle` turns the pickle bytes into a JS object
// tree; `annotate_snapshot` walks that tree to pair allocs/frees and
// attach versions. Our `parse_intern` covers both in one Rust call, so
// reporting the combined number gives the closest apples-to-apples.

import fs from "fs";
import vm from "vm";

const script = [
  "pytorch_unpickle.js",
  "pytorch_helpers.js",
  "pytorch_annotate.js",
]
  .map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8"))
  .join("\n\n");

// Run in this context so the function declarations land on globalThis.
vm.runInThisContext(script + "\n;globalThis.__pt = { unpickle, annotate_snapshot };");
const { unpickle, annotate_snapshot } = globalThis.__pt;

const pickle = fs.readFileSync(
  "/home/jay/memory_snapshot/iteration_2_exit/rank0_memory_snapshot.pickle",
);
console.log(`pickle ${(pickle.length / 1024 / 1024).toFixed(1)} MiB`);

function time(label, fn, warm = 1, runs = 3) {
  for (let i = 0; i < warm; i++) fn();
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  const avg = ts.reduce((a, b) => a + b, 0) / runs;
  console.log(
    `  ${label}: ${avg.toFixed(0)} ms avg (min ${Math.min(...ts).toFixed(0)})`,
  );
  return avg;
}

let data;
time("unpickle only", () => {
  data = unpickle(pickle.buffer);
});
time("annotate_snapshot only", () => {
  annotate_snapshot(data);
});
time("unpickle + annotate (end-to-end)", () => {
  const d = unpickle(pickle.buffer);
  annotate_snapshot(d);
});
