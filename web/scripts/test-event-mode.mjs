import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.locator('input[type="file"]').setInputFiles(["/home/jay/iteration_5/rank0_memory_snapshot.pickle"]);
await page.waitForSelector(".tl-phase-slot", { timeout: 60000 });
await page.waitForTimeout(3000);

async function capture(label) {
  const png = await page.evaluate(() => {
    const cs = document.querySelectorAll(".tl-phase-slot canvas");
    if (!cs.length) return null;
    const out = document.createElement("canvas");
    out.width = cs[0].width; out.height = cs[0].height;
    const ctx = out.getContext("2d");
    for (const c of cs) ctx.drawImage(c, 0, 0);
    return out.toDataURL("image/png");
  });
  if (png) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`/tmp/memviz-${label}.png`, Buffer.from(png.split(",")[1], "base64"));
  }
}

await capture("default-time");

// Switch to event mode (no anomaly click)
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".axis-toggle button"));
  btns.find((b) => b.textContent?.trim() === "event")?.click();
});
await page.waitForTimeout(1000);
await capture("after-event-switch");

await browser.close();
console.log("saved: /tmp/memviz-default-time.png /tmp/memviz-after-event-switch.png");
