import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
// click Anomalies tab and expand tray
await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll(".tray-tab"));
  tabs.find((b) => /anomalies/i.test(b.textContent || ""))?.click();
});
await page.waitForTimeout(400);
await page.locator(".tray-body").screenshot({ path: "/tmp/chip.png" });
await browser.close();
