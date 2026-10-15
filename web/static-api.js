// Static demo only (scripts/build-static.mjs puts this before app.js): answers the app's /api/* calls in the
// browser from the bundled snapshot, with the same engine code the server uses. No network, no API key:
// prices are the snapshot's, the chat is the rule-based offline answerer, and every result says so.
import { marketSummary, quotes, searchNames, DEFAULT_WATCHLIST } from "../engine/universe.js";
import { makeTools } from "../engine/tools.js";
import { makeOfflineAnswer, sanitizePortfolio } from "../engine/chat-offline.js";

const base = new URL("./", document.baseURI);
const manifest = fetch(new URL("data/manifest.json", base)).then((r) => r.json());
const series = new Map();

async function getHistory(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  const entry = (await manifest).find((m) => m.symbol === sym);
  if (!entry) throw new Error(`No data for ${sym}: this static demo only has the snapshot tickers. Run the app locally for live data.`);
  if (!series.has(sym)) series.set(sym, fetch(new URL(`data/snapshot/${entry.file}`, base)).then((r) => r.json()));
  const saved = await series.get(sym);
  // The saved market session is from when the snapshot was taken, not now.
  return { ...saved.data, session: "unknown", source: "snapshot", fetchedAt: saved.fetchedAt, ageMinutes: Math.round((Date.now() - saved.fetchedAt) / 60000) };
}

async function searchSymbols(query) {
  const q = String(query || "").trim();
  if (q.length < 1 || q.length > 60) throw new Error("Type 1–60 characters to search.");
  return { results: searchNames(await manifest, q).slice(0, 8), source: "offline" };
}

async function getProfile(symbol) {
  const sym = String(symbol || "").toUpperCase();
  const hit = (await searchSymbols(sym)).results.find((r) => r.symbol === sym);
  return hit ? { ...hit, source: "offline" } : { symbol: sym, name: null, type: null, sector: null, industry: null, source: "not found" };
}

const tools = makeTools((s) => getHistory(s), { search: searchSymbols, getProfile });
const offlineAnswer = makeOfflineAnswer({ tools, getHistory, notice: "Static demo: rule-based answers from the same tools. Run the app locally with ANTHROPIC_API_KEY set for Claude." });

async function chat({ messages = [], portfolio = {} }) {
  const clean = (Array.isArray(messages) ? messages : []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (!clean.length || clean.at(-1).role !== "user") throw new Error("Send at least one user message.");
  return offlineAnswer(clean.at(-1).content.slice(0, 2000), sanitizePortfolio(portfolio));
}

const routes = {
  "/api/health": async () => ({ ok: true, watchlist: DEFAULT_WATCHLIST, static: true }),
  "/api/history": async (q) => getHistory(q.get("symbol")),
  "/api/search": async (q) => searchSymbols(q.get("q")),
  "/api/profile": async (q) => getProfile(q.get("symbol")),
  "/api/market": async () => marketSummary(getHistory),
  "/api/quotes": async (q) => quotes(getHistory, (q.get("symbols") || "").split(",")),
};

// Nothing leaves the browser here, so the chat's privacy note says that instead of describing the server.
document.addEventListener("DOMContentLoaded", () => {
  const note = document.querySelector(".chat-privacy");
  if (note) note.textContent = "In this static demo nothing leaves your browser: answers are computed on this page from the bundled snapshot.";
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const path = url.pathname.slice(url.pathname.indexOf("/api/") >= 0 ? url.pathname.indexOf("/api/") : 0);
  // The app asks for samples at the site root ("/web/samples/…"); on GitHub Pages the site lives in a subfolder.
  if (url.origin === location.origin && url.pathname.startsWith("/web/samples/")) return realFetch(new URL(url.pathname.slice(1), base), init);
  if (url.origin !== location.origin || !path.startsWith("/api/")) return realFetch(input, init);
  try {
    if (path === "/api/chat" && (init.method || "GET").toUpperCase() === "POST") return json(await chat(JSON.parse(init.body || "{}")));
    const h = routes[path];
    return h ? json(await h(url.searchParams)) : json({ error: `No route ${path} in the static demo.` }, 404);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
};
