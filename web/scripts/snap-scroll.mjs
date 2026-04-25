import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

const measure = () => page.evaluate(() => {
  const track = document.querySelector(".timeline-track");
  const root = document.documentElement;
  return {
    trackClientH: Math.round(track.clientHeight),
    trackScrollH: Math.round(track.scrollHeight),
    canScroll: track.scrollHeight > track.clientHeight,
    scrollTop: track.scrollTop,
    trayReserve: getComputedStyle(root).getPropertyValue("--tray-reserve"),
    trayH: Math.round(document.querySelector(".tray").getBoundingClientRect().height),
  };
});

console.log("[collapsed]", await measure());

await page.evaluate(() => {
  const s = window.__store.getState();
  const a = s.timelineAllocs?.[0];
  if (a) s.setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
});
await page.waitForTimeout(400);
console.log("[expanded]", await measure());

// try scrolling
await page.evaluate(() => {
  const track = document.querySelector(".timeline-track");
  track.scrollTop = 200;
});
await page.waitForTimeout(200);
console.log("[after-scroll]", await measure());
await page.screenshot({ path: "/tmp/scroll-expanded.png" });

await browser.close();
