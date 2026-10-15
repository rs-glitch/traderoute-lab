// `npm run demo:record`: record the autoplaying guided demo to demo/traderoute-demo.webm.
// Needs Playwright (`npm i -D playwright && npx playwright install chromium`) and a running server (`npm start`).
import { chromium } from "playwright";
import { rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("./", import.meta.url));
const url = process.env.DEMO_URL || "http://localhost:4174/#demo";
const size = { width: 1440, height: 900 };
await mkdir(`${out}.video`, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: `${out}.video`, size } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
// Autoplay runs the full tour; wait until the final step shows.
await page.waitForSelector('.tour-card [data-t="replay"]', { timeout: 300000 });
await page.waitForTimeout(4000);
const video = page.video();
await ctx.close();
await browser.close();
const target = `${out}traderoute-demo.webm`;
await rename(await video.path(), target);
console.log(`Saved ${target}`);
