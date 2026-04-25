import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("[err]", msg.text());
});

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

await page.screenshot({ path: "/tmp/layout-full.png", fullPage: false });
console.log("saved /tmp/layout-full.png");

// Collapse sidebar
await page.locator(".rank-sidebar-toggle").click();
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/layout-collapsed.png", fullPage: false });
console.log("saved /tmp/layout-collapsed.png");

const dims = await page.evaluate(() => {
  const ps = document.querySelector(".tl-phase-slot");
  const rect = ps?.getBoundingClientRect();
  return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null;
});
console.log("phase slot:", dims);

await browser.close();
