// Headless diagnostic: loads the dev server, uploads a pickle, waits
// for Dashboard, inspects layout + anomaly click behavior.
// Usage:  node scripts/inspect-layout.mjs [url]

import { chromium } from "playwright";

const URL_ = process.argv[2] || "http://localhost:5173/";
const PICKLES = [
  "/home/jay/iteration_5/rank0_memory_snapshot.pickle",
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning") console.log(`[page:${t}]`, msg.text());
});
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

console.log("→ goto", URL_);
await page.goto(URL_, { waitUntil: "networkidle" });

// FileSelector is up. Upload pickles via the hidden file input.
console.log("→ uploading", PICKLES.length, "pickle(s)");
await page.locator('input[type="file"]').setInputFiles(PICKLES);

// Wait for Dashboard's tracks region to appear.
await page.waitForSelector(".tracks", { timeout: 30000 });
console.log("→ dashboard up");
await page.waitForTimeout(2000);

async function measure(label) {
  const dims = await page.evaluate(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const r = el.getBoundingClientRect();
      return { sel, x: r.x|0, y: r.y|0, w: r.width|0, h: r.height|0 };
    };
    return {
      scrollY: window.scrollY,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dashboard: pick(".dashboard"),
      tracks: pick(".tracks"),
      track_mr: pick(".tracks > .track:nth-child(1)"),
      track_tl: pick(".tracks > .track:nth-child(2)"),
      phase_slot: pick(".tl-phase-slot"),
      phase_canvas: pick(".tl-phase-slot canvas"),
      tray: pick(".tray"),
      anomalies_tab: pick('.tray-tab:nth-of-type(4)'),
    };
  });
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(dims, null, 2));
  return dims;
}

await measure("initial");

// Look for anomalies tab, click it, then click first anomaly row.
const anomaliesTab = page.locator(".tray-tab", { hasText: /anomalies/i }).first();
if (await anomaliesTab.count()) {
  console.log("→ opening Anomalies tab");
  await anomaliesTab.click();
  await page.waitForTimeout(300);
  const rowInfo = await page.evaluate(() => {
    const rows = document.querySelectorAll(".tray-body tbody tr");
    if (!rows.length) return { count: 0 };
    // Grab the first non-expanded row (odd rows in our markup).
    const row = rows[0];
    const r = row.getBoundingClientRect();
    // Dispatch click + React synthetic via native click event.
    row.click();
    return {
      count: rows.length,
      clicked: { x: r.x|0, y: r.y|0, w: r.width|0, h: r.height|0 },
      text: row.textContent?.trim().slice(0, 120),
    };
  });
  console.log("→ anomaly row click:", rowInfo);
  await page.waitForTimeout(800);
  await measure("after-anomaly-click");
} else {
  console.log("× no anomalies tab visible");
}

// Take a screenshot for inspection.
await page.screenshot({ path: "/tmp/memviz-after-click.png", fullPage: false });
console.log("→ screenshot saved to /tmp/memviz-after-click.png");

await browser.close();
