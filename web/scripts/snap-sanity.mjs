import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[err]", err.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
const d = await page.evaluate(() => ({
  phase: Math.round(document.querySelector(".tl-phase-slot").getBoundingClientRect().height),
  seg: Math.round(document.querySelector(".tl-segment-slot")?.getBoundingClientRect().height ?? 0),
  sidebar: Math.round(document.querySelector(".rank-sidebar")?.getBoundingClientRect().width ?? 0),
}));
console.log(d);
await browser.close();
