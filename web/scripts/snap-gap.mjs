import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

const d = await page.evaluate(() => {
  const q = (s) => Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? 0);
  return {
    track: q(".timeline-track"),
    trackContent: document.querySelector(".timeline-track")?.clientHeight,
    frame: q(".tl-frame"),
    phase: q(".tl-phase-slot"),
    divider: q(".tl-divider"),
    segment: q(".tl-segment-slot"),
    spacer: q(".tl-tray-spacer"),
    tray: q(".tray"),
  };
});
console.log("[filled]", d);
await page.screenshot({ path: "/tmp/gap-test.png" });
await browser.close();
