import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

// snap track-head with shortcuts button
const head = page.locator(".track-head").nth(1);
await head.screenshot({ path: "/tmp/track-head.png" });

// hover shortcuts to reveal popover
await page.locator(".tl-shortcuts").hover();
await page.waitForTimeout(200);
await page.screenshot({
  path: "/tmp/shortcuts-hover.png",
  clip: { x: 1200, y: 0, width: 720, height: 300 },
});

// Details tab with nothing selected
await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll(".tray-tab"));
  tabs.find((b) => /details/i.test(b.textContent || ""))?.click();
});
await page.waitForTimeout(300);
await page.locator(".tray-body").first().screenshot({ path: "/tmp/details-empty.png" });

console.log("saved: /tmp/track-head.png /tmp/shortcuts-hover.png /tmp/details-empty.png");
await browser.close();
