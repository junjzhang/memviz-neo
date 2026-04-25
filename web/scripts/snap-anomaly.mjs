import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll(".tray-tab"));
  tabs.find((b) => /anomalies/i.test(b.textContent || ""))?.click();
});
await page.waitForTimeout(500);

const tray = await page.locator(".tray-body").first();
await tray.screenshot({ path: "/tmp/anomaly-tray.png" });
console.log("saved /tmp/anomaly-tray.png");

await browser.close();
