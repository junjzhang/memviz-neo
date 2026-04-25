// Poll viewRangeRef at 30ms intervals for 2s after anomaly click to
// watch the animation trajectory. Reveals who is *actually* writing
// the ref.

import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

async function setMode(mode) {
  await page.evaluate((m) => {
    const btns = Array.from(document.querySelectorAll(".axis-toggle button"));
    btns.find((b) => b.textContent?.trim() === m)?.click();
  }, mode);
  await page.waitForTimeout(400);
}
async function openAnomalies() {
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll(".tray-tab"));
    tabs.find((b) => /anomalies/i.test(b.textContent || ""))?.click();
  });
  await page.waitForTimeout(300);
}

async function trace(label) {
  await openAnomalies();
  // Kick polling, then click.
  const result = await page.evaluate(async () => {
    const log = [];
    const t0 = performance.now();
    const push = (tag) => {
      const s = window.__store.getState();
      log.push({
        t: Math.round(performance.now() - t0),
        tag,
        view: window.__viewRange?.current ? [...window.__viewRange.current] : null,
        mode: s.xAxisMode,
        focusRange: s.focusRange,
        focusedAddr: s.focusedAddr,
      });
    };
    push("pre-click");
    const row = document.querySelector(".tray-body tbody tr");
    if (row) row.click();
    push("post-click-sync");
    // Poll every 30ms for 2s.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 33));
      push(`t+${i * 33}ms`);
    }
    return log;
  });
  console.log(`=== ${label} ===`);
  // Dedup: only log entries where view changes.
  let last = null;
  for (const r of result) {
    const key = JSON.stringify(r.view);
    if (key !== last) {
      console.log(`  [${r.t.toString().padStart(4)}ms] ${r.tag.padEnd(22)} view=${key}`);
      last = key;
    }
  }
}

await setMode("event");
await trace("EVENT mode");
await page.evaluate(() => window.__store.getState().clearFocus?.());
await setMode("time");
await trace("TIME mode");

await browser.close();
