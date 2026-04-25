import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

const dump = async () => page.evaluate(() => {
  const q = (s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().height) : null;
  };
  return {
    dashMain: q(".dashboard-main"),
    timelineTrack: q(".timeline-track"),
    tlFrame: q(".tl-frame"),
    phaseSlot: q(".tl-phase-slot"),
    segSlot: q(".tl-segment-slot"),
    tray: q(".tray"),
    trayPos: (() => {
      const el = document.querySelector(".tray");
      return el ? getComputedStyle(el).position : null;
    })(),
  };
});

console.log("[initial]", await dump());
await page.screenshot({ path: "/tmp/float-initial.png" });

await page.evaluate(() => {
  const s = window.__store.getState();
  const a = s.timelineAllocs?.[0];
  if (a) s.setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
});
await page.waitForTimeout(500);
console.log("[after select]", await dump());
await page.screenshot({ path: "/tmp/float-expanded.png" });

await browser.close();
