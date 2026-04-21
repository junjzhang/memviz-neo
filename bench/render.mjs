// Automated parse + memory bench for memviz/neo.
//
// Boots a static server on web/dist, drives Playwright Chromium through
// the actual user path (pick file → wait for dashboard), and reports:
//   - T_parse   : pickle bytes → summary in store (WASM parse wall-clock)
//   - T_render  : parse done → first timeline canvas painted
//   - JS heap used after load (performance.memory)
//   - Total UA memory (performance.measureUserAgentSpecificMemory, COOP/COEP)
//
// FPS is intentionally not measured here. Headless chromium falls back to
// software WebGL (SwiftShader), which makes render timings 10-50× slower
// than a real GPU and useless for regression tracking. Pass `--headed` to
// open a visible window and get real-GPU numbers; on a server/CI without
// a display, stick to the default (memory + parse only).
//
// Run:
//   node bench/render.mjs [path/to/pickle] [--headed]

import http from "http";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const headed = process.argv.includes("--headed");
const PICKLE = argv[0] || "/home/jay/memory_snapshot/iteration_2_exit/rank0_memory_snapshot.pickle";
const DIST = path.resolve(new URL("../web/dist", import.meta.url).pathname);
if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error(`web/dist not found — run \`cd web && pnpm build\` first`);
  process.exit(1);
}
if (!fs.existsSync(PICKLE)) {
  console.error(`pickle not found: ${PICKLE}`);
  process.exit(1);
}

// --- tiny static server (ESM + wasm mime + COOP/COEP for precise memory) ---
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".json": "application/json", ".ico": "image/x-icon", ".png": "image/png",
};
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const abs = path.join(DIST, rel);
  if (!abs.startsWith(DIST) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  const ext = path.extname(abs);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const URL_ = `http://127.0.0.1:${port}/`;

const pickleSize = fs.statSync(PICKLE).size;
console.log(`pickle ${(pickleSize / 1024 / 1024).toFixed(1)} MiB · ${path.basename(PICKLE)}`);
console.log(`mode   ${headed ? "HEADED (real GPU)" : "HEADLESS (swiftshader — FPS not measured)"}`);

const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--enable-precise-memory-info",
    // Headed chromium throttles rAF to ~1Hz when the window loses focus,
    // which tanks our FPS measurements the moment playwright's UI or
    // another app takes focus. Disable the throttle + background-tab
    // timer throttle so numbers match what a focused user would see.
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("requestfailed", (r) => console.error("REQ FAIL:", r.url(), r.failure()?.errorText));

// --- load page ---
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[type="file"]', { state: "attached" });

// Hook DOM transitions so we can separate "parse done" from "render done".
// .hx-v.hl appears once the fileStore has a summary for the first rank.
// .tl-canvas mounts once the layout worker returns + React paints.
await page.evaluate(() => {
  window.__marks = { t0: performance.now() };
  const obs = new MutationObserver(() => {
    if (!window.__marks.parse && document.querySelector(".hx-v.hl")) {
      window.__marks.parse = performance.now();
    }
    if (!window.__marks.render && document.querySelector(".tl-canvas")) {
      window.__marks.render = performance.now();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
});

// --- trigger the actual parse path ---
await page.setInputFiles('input[type="file"]', PICKLE);
await page.waitForFunction(() => window.__marks?.parse, null, { timeout: 30000 });
await page.waitForFunction(() => window.__marks?.render, null, { timeout: 60000 });

const marks = await page.evaluate(() => window.__marks);
const tParse = marks.parse - marks.t0;
const tRender = marks.render - marks.parse;
console.log(`  T_parse   (pickle bytes → summary in store): ${tParse.toFixed(0)} ms`);
console.log(`  T_render  (summary → first timeline canvas):  ${tRender.toFixed(0)} ms`);

// --- memory snapshot ---
const perfMem = await page.evaluate(() => performance.memory ? {
  usedJSHeapSize: performance.memory.usedJSHeapSize,
  totalJSHeapSize: performance.memory.totalJSHeapSize,
  jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
} : null);
console.log(`  JS heap (used / total): ${(perfMem.usedJSHeapSize / 1024 / 1024).toFixed(1)} / ${(perfMem.totalJSHeapSize / 1024 / 1024).toFixed(1)} MiB`);

const uaMem = await page.evaluate(async () => {
  if (!performance.measureUserAgentSpecificMemory) return null;
  try { return await performance.measureUserAgentSpecificMemory(); }
  catch (e) { return { error: String(e) }; }
});
if (uaMem?.bytes) {
  console.log(`  Total UA memory (JS + WASM + DOM): ${(uaMem.bytes / 1024 / 1024).toFixed(1)} MiB`);
}

// --- FPS only when running headed (real GPU) ---
if (headed) {
  console.log("\n-- FPS probes (real GPU) --");
  await page.locator(".tl-canvas").first().click({ position: { x: 400, y: 200 } });

  async function fpsProbe(label, durationMs, action) {
    await page.evaluate((dur) => {
      window.__frames = [];
      window.__probeDone = false;
      const start = performance.now();
      const onFrame = (t) => {
        window.__frames.push(t);
        if (t - start < dur) requestAnimationFrame(onFrame);
        else window.__probeDone = true;
      };
      requestAnimationFrame(onFrame);
    }, durationMs);
    await action();
    await page.waitForFunction(() => window.__probeDone, null, { timeout: durationMs + 10000 });
    const frames = await page.evaluate(() => window.__frames);
    if (frames.length < 2) { console.log(`  ${label}: insufficient frames`); return; }
    const deltas = [];
    for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
    deltas.sort((a, b) => a - b);
    const p50 = deltas[Math.floor(deltas.length * 0.5)];
    const p95 = deltas[Math.floor(deltas.length * 0.95)];
    const fps = 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length);
    console.log(`  ${label}: ${fps.toFixed(1)} fps · frame p50/p95 = ${p50.toFixed(1)} / ${p95.toFixed(1)} ms (${frames.length} frames)`);
  }

  // Escape before each probe — the initial click focuses the canvas but
  // may also select an alloc, and drawing the selection polygon every
  // frame is what we're trying NOT to measure here.
  await page.keyboard.press("Escape");
  await fpsProbe("idle 2s", 2000, () => page.waitForTimeout(2000));
  await page.keyboard.press("Escape");
  await fpsProbe("pan 'd' 5s", 5000, async () => {
    await page.keyboard.down("d"); await page.waitForTimeout(5000); await page.keyboard.up("d");
  });
  await page.keyboard.press("Escape");
  await page.locator(".tl-canvas").first().focus();
  await fpsProbe("zoom 'w' 3s", 3000, async () => {
    await page.keyboard.down("w"); await page.waitForTimeout(3000); await page.keyboard.up("w");
  });
}

await browser.close();
server.close();
