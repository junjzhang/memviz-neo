import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("[err]", err.message));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/main-timeline.png", clip: { x: 0, y: 0, width: 2560, height: 600 } });

// switch to flame
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".main-view-tabs button"));
  btns.find((b) => /flame/i.test(b.textContent || ""))?.click();
});
await page.waitForTimeout(800);
const d = await page.evaluate(() => ({
  active: document.querySelector(".main-view-tabs .is-active")?.textContent?.trim(),
  flameH: Math.round(document.querySelector(".flame-main")?.getBoundingClientRect().height ?? 0),
  flameCanvas: document.querySelector(".flame-main canvas") ? "yes" : "no",
  trayTabs: Array.from(document.querySelectorAll(".tray-tab")).map((b) => b.textContent?.trim().split("\n")[0]),
}));
console.log(d);
await page.screenshot({ path: "/tmp/main-flame.png", clip: { x: 0, y: 0, width: 2560, height: 600 } });
await browser.close();
