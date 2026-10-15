// Static web app + JSON API. The browser runs the engine itself; the server supplies data.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getHistory, DEFAULT_WATCHLIST } from "./data.js";
import { marketSummary, quotes } from "../engine/universe.js";
import { searchSymbols, getProfile } from "./search.js";
import { chat } from "./chat.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4174;
const HOST = process.env.HOST || "127.0.0.1"; // local only by default: /api/chat can spend API credits
const TYPES = { ".csv": "text/csv; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const routes = {
  "/api/health": async () => ({ ok: true, watchlist: DEFAULT_WATCHLIST }),
  "/api/history": async (q) => getHistory(q.get("symbol"), { range: q.get("range") || "5y" }),
  "/api/search": async (q) => searchSymbols(q.get("q")),
  "/api/profile": async (q) => getProfile(q.get("symbol")),
  "/api/market": async () => marketSummary(getHistory),
  "/api/quotes": async (q) => quotes(getHistory, (q.get("symbols") || "").split(",")),
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 2e5) throw new Error("Request too large."); }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "POST" && url.pathname === "/api/chat") return send(res, 200, await chat(await readJson(req)));
    const h = routes[url.pathname];
    if (h) return send(res, 200, await h(url.searchParams));
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: `No route ${url.pathname}. Try ${Object.keys(routes).join(", ")}` });
    const rel = url.pathname === "/" ? "web/index.html" : url.pathname.slice(1);
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT) || !/^(web|engine)[/\\]/.test(rel)) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
  } catch (err) {
    return send(res, err.code === "ENOENT" ? 404 : 400, { error: err.message });
  }
}).listen(PORT, HOST, () => console.log(`TradeRoute Lab → http://localhost:${PORT} (bound to ${HOST}; education & simulation only, not investment advice)`));
