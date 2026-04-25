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

const dump = () => page.evaluate(() => ({
  phase: Math.round(document.querySelector(".tl-phase-slot").getBoundingClientRect().height),
  seg: Math.round(document.querySelector(".tl-segment-slot").getBoundingClientRect().height),
  segCanvas: Math.round(document.querySelector(".tl-segment-slot canvas")?.getBoundingClientRect().height ?? 0),
}));
console.log("[initial]", await dump());
await page.screenshot({ path: "/tmp/seg-initial.png", clip: { x: 0, y: 700, width: 2560, height: 700 } });

// drag divider up 300 (smaller phase, bigger segment slot)
const box = await page.locator(".tl-divider").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y - 300, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
console.log("[drag -300]", await dump());
await page.screenshot({ path: "/tmp/seg-expanded.png", clip: { x: 0, y: 400, width: 2560, height: 1000 } });

await browser.close();
