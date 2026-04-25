// Verify anomaly click behavior: reads viewRangeRef (exposed on
// window.__viewRange) before/after click to confirm the focus
// animation lands on the right range in both TIME and EVENT modes.

import { chromium } from "playwright";

const PICKLES = ["/home/jay/iteration_5/rank0_memory_snapshot.pickle"];
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(PICKLES);
await page.waitForSelector(".tl-phase-slot", { timeout: 60000 });
await page.waitForTimeout(2500);

async function probe(mode, label) {
  await page.evaluate((m) => {
    const btns = Array.from(document.querySelectorAll(".axis-toggle button"));
    btns.find((b) => b.textContent?.trim() === m)?.click();
  }, mode);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const ds = (window).__viewRange;
    return ds ? [...ds.current] : null;
  });

  // Open anomalies tab + click first row.
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll(".tray-tab"));
    tabs.find((b) => /anomalies/i.test(b.textContent || ""))?.click();
  });
  await page.waitForTimeout(300);
  const clickInfo = await page.evaluate(() => {
    const row = document.querySelector(".tray-body tbody tr");
    const text = row ? row.textContent?.trim().slice(0, 80) : null;
    if (row) row.click();
    return text;
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const ds = (window).__viewRange;
    return ds ? [...ds.current] : null;
  });

  // Probe store focusRange.
  const focusRange = await page.evaluate(() => {
    // Grab via zustand subscribe through window-exposed store if any.
    return null; // fallback — we compare before/after only
  });

  console.log(`[${mode}] row="${clickInfo}"\n  before:`, before, "\n  after:", after);
  return { before, after };
}

await probe("time", "time");
// Reset viewRange to full by pressing Escape + double-clicking canvas
// via code (focus clears require fresh click).
await page.evaluate(() => (window).__viewRange.current = [0, 1e9]);
await probe("event", "event");

await browser.close();
