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
  frame: Math.round(document.querySelector(".tl-frame").getBoundingClientRect().height),
  track: Math.round(document.querySelector(".timeline-track").clientHeight),
}));

console.log("[initial]", await dump());

// drag divider down 200px
const box = await page.locator(".tl-divider").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
console.log("[drag +200]", await dump());

// drag divider up 400 (divider has moved 200 down, so start from new position)
const b2 = await page.locator(".tl-divider").boundingBox();
await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
await page.mouse.down();
await page.mouse.move(b2.x + b2.width / 2, b2.y - 400, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
console.log("[drag -400]", await dump());

await page.screenshot({ path: "/tmp/div2.png" });
await browser.close();
