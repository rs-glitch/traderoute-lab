// `npm run test:ui`: open the app in headless Chromium and use it like a visitor would. Every tab must render,
// the sample portfolio must import, the chat must answer, nothing may log an error or scroll sideways on a phone.
//   node test/ui-smoke.mjs            → the Node server, offline (TRL_OFFLINE=1, snapshot data)
//   node test/ui-smoke.mjs --static   → the GitHub Pages build (site/), served from a subfolder like Pages does
//   --shots DIR                       → also save screenshots (used for the README)
// Needs Playwright's Chromium once: npx playwright install chromium
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const isStatic = args.includes("--static");
const shots = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".csv": "text/csv" };

async function startStatic() {
  await new Promise((ok, fail) => spawn(process.execPath, [join(ROOT, "scripts", "build-static.mjs")], { stdio: "inherit" }).on("exit", (c) => (c ? fail(new Error("build failed")) : ok())));
  const SITE = join(ROOT, "site"), PREFIX = "/traderoute-lab/";
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!path.startsWith(PREFIX)) { res.writeHead(404); return res.end(); } // anything outside the subfolder is a broken path
    const file = normalize(join(SITE, path.slice(PREFIX.length) || "index.html"));
    try { const body = await readFile(file); res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}${PREFIX}`, stop: () => server.close() };
}

async function startNode() {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(ROOT, "server", "http.js")], { env: { ...process.env, TRL_OFFLINE: "1", PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, fail) => { child.stdout.on("data", (d) => /localhost/.test(d) && ok()); child.on("exit", (c) => fail(new Error(`server exited ${c}`))); });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

const target = isStatic ? await startStatic() : await startNode();
const browser = await chromium.launch();
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const local = (u) => u.startsWith(new URL(target.url).origin);
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => local(r.url()) && problems.push(`request failed: ${r.url()}`));
  page.on("response", (r) => local(r.url()) && r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
  const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll("#home-market .idx").length >= 6);
  assert.match(await page.textContent("#home-market"), /bp\s*1M/, "the 10-year yield's 1-month change should read in basis points");

  await page.click('#home-portfolio [data-sample]');
  await page.waitForSelector("#home-portfolio svg");
  await page.evaluate(() => scrollTo(0, 0));
  await shot("home");

  const tabs = { market: "#market-table tr:nth-child(2)", exposure: "#exposure svg", ticker: "#price-chart svg", plan: "#routes > *", paper: "#paper-tiles > *", methods: "#methods h2" };
  for (const [tab, ready] of Object.entries(tabs)) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForSelector(ready, { state: "attached", timeout: 15000 }).catch(() => { throw new Error(`${tab} tab: nothing matched ${ready}`); });
    await page.waitForTimeout(300);
    await shot(tab);
    if (/(^|[^\d.])-0%/.test(await page.textContent("main"))) problems.push(`${tab} tab shows a negative zero (-0%)`);
  }

  await page.click('[data-tab="exposure"]');
  await page.click("#chat-fab");
  await page.fill("#chat-input", "How diversified is my portfolio?");
  await page.press("#chat-input", "Enter");
  await page.waitForFunction(() => /Not investment advice/.test(document.querySelector("#chat-log")?.textContent ?? ""), null, { timeout: 15000 });
  await shot("chat");
  if (/-0%/.test(await page.textContent("#chat-log"))) problems.push("chat shows a negative zero (-0%)");
  if (isStatic) assert.match(await page.textContent(".chat-privacy"), /nothing leaves your browser/, "static demo must not claim data goes to a server");
  await page.click("#chat-close");

  await page.setViewportSize({ width: 400, height: 860 });
  for (const tab of Object.keys(tabs)) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(200);
    const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    if (sw > w) problems.push(`${tab}: page scrolls sideways at phone width (${sw}px > ${w}px)`);
  }
} catch (err) {
  problems.push(`step failed: ${err.message.split("\n")[0]}`);
} finally {
  await browser.close();
  target.stop();
}
if (problems.length) { console.error(`UI smoke (${isStatic ? "static" : "server"}): ${problems.length} problem(s)\n  ${problems.join("\n  ")}`); process.exit(1); }
console.log(`UI smoke (${isStatic ? "static site" : "server"}): all tabs render, sample import and chat work, no errors, no sideways scroll at 400 px`);
