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

const sample = () => page.evaluate(() => ({
  phaseH: Math.round(document.querySelector(".tl-phase-slot").getBoundingClientRect().height),
  segH: Math.round(document.querySelector(".tl-segment-slot").getBoundingClientRect().height),
  hasDivider: !!document.querySelector(".tl-divider"),
}));

console.log("[initial]", await sample());

// drag divider 200px down
const divider = page.locator(".tl-divider");
const box = await divider.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log("[drag +200]", await sample());

// drag back up
const d2 = await divider.boundingBox();
await page.mouse.move(d2.x + d2.width / 2, d2.y + d2.height / 2);
await page.mouse.down();
await page.mouse.move(d2.x + d2.width / 2, d2.y - 300, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log("[drag -300]", await sample());

const stored = await page.evaluate(() => localStorage.getItem("phase-height"));
console.log("[localStorage]", stored);

await page.screenshot({ path: "/tmp/divider.png" });
await browser.close();
