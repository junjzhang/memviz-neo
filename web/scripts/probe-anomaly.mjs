// Probe focusRange + viewRange + eventTimes bounds to see where the
// event-mode jump lands. Reads via window.__store / window.__viewRange.

import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("console", (msg) => {
  const t = msg.text();
  if (msg.type() === "error" || t.startsWith("[focus]")) console.log("[page]", t);
});

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

async function snapshot(tag) {
  return await page.evaluate(() => {
    const s = window.__store?.getState?.();
    const vr = window.__viewRange?.current;
    const evt = s?.eventTimes;
    const tl = s?.timeline;
    return {
      mode: s?.xAxisMode,
      view: vr ? [...vr] : null,
      focusRange: s?.focusRange,
      focusedAddr: s?.focusedAddr,
      time_min: tl?.time_min,
      time_max: tl?.time_max,
      eventCount: evt ? evt.length : null,
      evtFirst: evt ? evt[0] : null,
      evtLast: evt ? evt[evt.length - 1] : null,
      anomalyCount: s?.anomalies?.length,
      firstAnomaly: s?.anomalies?.[0]
        ? {
            addr: s.anomalies[0].addr,
            alloc_us: s.anomalies[0].alloc_us,
            free_us: s.anomalies[0].free_us,
            size: s.anomalies[0].size,
            type: s.anomalies[0].type,
          }
        : null,
    };
  });
}

async function setMode(mode) {
  await page.evaluate((m) => {
    const btns = Array.from(document.querySelectorAll(".axis-toggle button"));
    btns.find((b) => b.textContent?.trim() === m)?.click();
  }, mode);
  await page.waitForTimeout(400);
}

async function openAnomaliesTab() {
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll(".tray-tab"));
    tabs.find((b) => /anomalies/i.test(b.textContent || ""))?.click();
  });
  await page.waitForTimeout(300);
}

async function clickFirstAnomaly() {
  return await page.evaluate(() => {
    const row = document.querySelector(".tray-body tbody tr");
    const text = row ? row.textContent?.trim().slice(0, 100) : null;
    if (row) row.click();
    return text;
  });
}

function compute(snap) {
  if (!snap.firstAnomaly || snap.time_min == null) return null;
  const { alloc_us, free_us } = snap.firstAnomaly;
  const padding = Math.max(100000, (free_us > 0 ? free_us - alloc_us : 1000000) * 0.3);
  const tMin = alloc_us - padding;
  const tMax = (free_us > 0 ? free_us : alloc_us + padding * 2) + padding;
  return {
    tMin_us: tMin,
    tMax_us: tMax,
    tMin_rel: tMin - snap.time_min,
    tMax_rel: tMax - snap.time_min,
    tMin_relSec: (tMin - snap.time_min) / 1e6,
    tMax_relSec: (tMax - snap.time_min) / 1e6,
  };
}

// ---- EVENT mode probe ----
await setMode("event");
const s0 = await snapshot("event-init");
console.log("[event init]", JSON.stringify(s0, null, 2));
console.log("[computed focus window for 1st anomaly]", JSON.stringify(compute(s0), null, 2));

await openAnomaliesTab();
const row = await clickFirstAnomaly();
console.log("[click row]", row);
await page.waitForTimeout(5000);
const s1 = await snapshot("event-after-click");
console.log("[event after click]", JSON.stringify(s1, null, 2));

// ---- TIME mode probe ----
await page.evaluate(() => window.__store.getState().clearFocus?.());
await setMode("time");
const s2 = await snapshot("time-init");
console.log("[time init]", JSON.stringify(s2, null, 2));

await openAnomaliesTab();
const row2 = await clickFirstAnomaly();
console.log("[click row]", row2);
await page.waitForTimeout(5000);
const s3 = await snapshot("time-after-click");
console.log("[time after click]", JSON.stringify(s3, null, 2));

await browser.close();
