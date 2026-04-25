import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

// 1) initial: tray should be collapsed, timeline tall
const initial = await page.evaluate(() => {
  const tray = document.querySelector(".tray");
  const ps = document.querySelector(".tl-phase-slot");
  return {
    trayH: tray?.getBoundingClientRect().height,
    timelineH: ps?.getBoundingClientRect().height,
  };
});
console.log("[initial]", initial);
await page.screenshot({ path: "/tmp/tray-initial.png" });

// 2) simulate alloc selection via store
await page.evaluate(() => {
  const s = window.__store.getState();
  // pick first timeline alloc
  const allocs = s._currentData?.timeline ? null : null;
  // fallback: grab from timelineAllocs via dataStore
  const ta = s.timelineAllocs;
  if (!ta || ta.length === 0) return;
  const a = ta[0];
  s.setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
});
await page.waitForTimeout(400);

const afterSelect = await page.evaluate(() => {
  const tray = document.querySelector(".tray");
  const ps = document.querySelector(".tl-phase-slot");
  const activeTab = document.querySelector(".tray-tab.is-active")?.textContent?.trim().slice(0, 20);
  return {
    trayH: tray?.getBoundingClientRect().height,
    timelineH: ps?.getBoundingClientRect().height,
    activeTab,
  };
});
console.log("[after select]", afterSelect);
await page.screenshot({ path: "/tmp/tray-expanded.png" });

// 3) clear selection — tray should stay expanded (respect user)
await page.evaluate(() => window.__store.getState().setSelectedAlloc(null));
await page.waitForTimeout(400);
const afterClear = await page.evaluate(() => {
  const tray = document.querySelector(".tray");
  return { trayH: tray?.getBoundingClientRect().height };
});
console.log("[after clear]", afterClear);

// 4) collapse via button, then re-select
await page.locator(".tray-collapse").click();
await page.waitForTimeout(300);
const afterCollapse = await page.evaluate(() => {
  const tray = document.querySelector(".tray");
  return { trayH: tray?.getBoundingClientRect().height };
});
console.log("[after manual collapse]", afterCollapse);

await page.evaluate(() => {
  const s = window.__store.getState();
  const a = s.timelineAllocs?.[1];
  if (a) s.setSelectedAlloc({ addr: a.addr, alloc_us: a.alloc_us });
});
await page.waitForTimeout(400);
const reopen = await page.evaluate(() => {
  const tray = document.querySelector(".tray");
  return { trayH: tray?.getBoundingClientRect().height };
});
console.log("[auto-expand after re-select]", reopen);

await browser.close();
