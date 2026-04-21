// Benchmark desktop_memory_viz's Python pickle → JSON extractor on the
// same snapshot. The desktop viewer itself is a native Rust eframe/egui
// app that reads the JSON this script produces; the pickle-parsing work
// happens here in Python.
//
// Clone desktop_memory_viz and set DMV_DIR to its path, or drop it at
// the default /tmp/compare/desktop_memory_viz.
import fs from "fs";
import { spawnSync } from "child_process";

const DMV = process.env.DMV_DIR || "/tmp/compare/desktop_memory_viz";
const SCRIPT = `${DMV}/extract_snapshot.py`;
if (!fs.existsSync(SCRIPT)) {
  console.error(`extract_snapshot.py not found at ${SCRIPT}`);
  console.error("Clone https://github.com/C-J-Cundy/desktop_memory_viz and set DMV_DIR.");
  process.exit(1);
}

const pickle = "/home/jay/memory_snapshot/iteration_2_exit/rank0_memory_snapshot.pickle";
console.log(`pickle ${(fs.statSync(pickle).size / 1024 / 1024).toFixed(1)} MiB`);

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

const out = "/tmp/dmv_bench.json";
time("extract_snapshot.py (pickle → JSON)", () => {
  const r = spawnSync("python3", [SCRIPT, pickle, out], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`python exited ${r.status}`);
});

console.log(`  output JSON ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MiB`);
