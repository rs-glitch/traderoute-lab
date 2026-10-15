// `npm run build:static`: a static copy of the app for GitHub Pages in site/. The browser answers the app's
// /api/* calls from the bundled snapshot (web/static-api.js), so it needs no server: snapshot prices only,
// rule-based chat. Serve site/ from any static host, at the root or in a subfolder.
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site");
const SNAP = join(ROOT, "data", "snapshot");

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "data"), { recursive: true });
await cp(join(ROOT, "web"), join(OUT, "web"), { recursive: true });
await cp(join(ROOT, "engine"), join(OUT, "engine"), { recursive: true });
await cp(SNAP, join(OUT, "data", "snapshot"), { recursive: true });

const manifest = [];
for (const file of (await readdir(SNAP)).filter((f) => f.endsWith(".json")).sort()) {
  const { data, fetchedAt } = JSON.parse(await readFile(join(SNAP, file), "utf8"));
  manifest.push({ symbol: data.symbol, name: data.name, exchange: data.exchange, type: data.type || null, file, fetchedAt });
}
await writeFile(join(OUT, "data", "manifest.json"), JSON.stringify(manifest));

// Relative asset paths (the site may live in a subfolder), and the API shim before the app.
let html = await readFile(join(ROOT, "web", "index.html"), "utf8");
const swaps = [
  ['href="/web/styles.css"', 'href="web/styles.css"'],
  ['<script type="module" src="/web/app.js"></script>', '<script type="module" src="web/static-api.js"></script>\n  <script type="module" src="web/app.js"></script>'],
];
for (const [from, to] of swaps) {
  if (!html.includes(from)) throw new Error(`index.html changed: can't find ${from}`);
  html = html.replace(from, to);
}
await writeFile(join(OUT, "index.html"), html);
await writeFile(join(OUT, ".nojekyll"), ""); // serve files as they are

const asOf = new Date(Math.max(...manifest.map((m) => m.fetchedAt))).toISOString().slice(0, 10);
console.log(`site/ built: ${manifest.length} snapshot series (as of ${asOf}). Preview: npx serve site  (or any static server)`);
