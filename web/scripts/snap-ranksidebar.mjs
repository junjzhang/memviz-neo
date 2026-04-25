import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
// Use pickle with 8 ranks if available; fall back to rank0
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

const d = await page.evaluate(() => {
  const sidebar = document.querySelector(".rank-sidebar");
  const row = document.querySelector(".rank-row");
  const head = document.querySelector(".rank-sidebar-head");
  return {
    sidebarW: Math.round(sidebar.getBoundingClientRect().width),
    headH: Math.round(head.getBoundingClientRect().height),
    rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
  };
});
console.log(d);
await page.locator(".rank-sidebar").screenshot({ path: "/tmp/rank-sidebar.png" });
await browser.close();
