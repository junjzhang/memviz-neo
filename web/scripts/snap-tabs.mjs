import { chromium } from "playwright";

const PICKLE = "/home/jay/iteration_5/rank0_memory_snapshot.pickle";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles([PICKLE]);
await page.waitForSelector(".tl-phase-slot canvas", { timeout: 60000 });
await page.waitForTimeout(2500);

const tabs = await page.locator(".tray-tabs").first();
await tabs.screenshot({ path: "/tmp/tray-tabs.png" });
console.log("saved /tmp/tray-tabs.png");

await browser.close();
