// Benchmark memviz/neo's WASM pickle path. Two measurements:
//
//   parse_pickle_only  — pure pickle bytes → Rc<Value> tree. Direct
//     analogue of pytorch's `unpickle`, so comparing this to
//     bench/pytorch.mjs's `unpickle only` line is apples-to-apples.
//
//   parse_intern       — the full pipeline: pickle decode + frame/stack
//     interning + alloc/free pairing + top-N selection + IR JSON emit.
//     pytorch defers all of these to view-open time, so comparing this
//     to pytorch's `unpickle` is NOT apples-to-apples — it's measuring
//     extra work we do up front to make downstream view switches instant.
//
// The layout_limit parameter only affects how much of the top-N IR we
// emit; the heavy lifting (parse, intern, pair) is constant.
import fs from "fs";
import { readFile } from "fs/promises";
import init, { parse_intern, parse_pickle_only } from "/home/jay/memviz-neo/wasm/pkg/memviz_wasm.js";

const wasmBuf = await readFile("/home/jay/memviz-neo/wasm/pkg/memviz_wasm_bg.wasm");
await init(wasmBuf);

const pickle = fs.readFileSync("/home/jay/memory_snapshot/iteration_2_exit/rank0_memory_snapshot.pickle");
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

console.log("\n== pickle decode only (apples-to-apples vs pytorch unpickle) ==");
time("parse_pickle_only", () => parse_pickle_only(pickle));

console.log("\n== full parse_intern (decode + intern + pair + top-N + IR emit) ==");
for (const limit of [3000, 10000, 20000, 0]) {
  time(`parse_intern(limit=${limit || "all"})`, () => parse_intern(pickle, 0, limit));
}
