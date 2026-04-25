import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const s = window.__store.getState();
  const a = s.timelineAllocs?.[0];
  if (a) s.setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
});
await page.waitForTimeout(500);
await page.locator(".tray-body").screenshot({ path: "/tmp/details.png" });
await browser.close();
