// Symbol search and company profiles via Yahoo's v1 search endpoint (unofficial, no key).
// Tradable types only; results cached. Offline, it falls back to the built-in names of the snapshot tickers.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchNames } from "../engine/universe.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TradeRouteLab/0.1";
const TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND", "CRYPTOCURRENCY"]);
const SNAP = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "snapshot");
const cache = new Map();

export function parseSearch(json) {
  return (json?.quotes ?? []).filter((q) => TYPES.has(q.quoteType)).map((q) => ({
    symbol: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchDisp, type: q.quoteType,
    typeLabel: q.typeDisp, sector: q.sector || null, industry: q.industry || null,
  }));
}

function offline(query) {
  if (!existsSync(SNAP)) return [];
  return searchNames(readdirSync(SNAP).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(SNAP, f), "utf8")).data), query);
}

export async function searchSymbols(query, { fetchImpl = fetch, limit = 8 } = {}) {
  const q = String(query || "").trim();
  if (q.length < 1 || q.length > 60) throw new Error("Type 1–60 characters to search.");
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  try {
    if (process.env.TRL_OFFLINE === "1") throw new Error("offline mode (TRL_OFFLINE=1)");
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${limit + 6}&newsCount=0&listsCount=0`;
    const res = await fetchImpl(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = { results: parseSearch(await res.json()).slice(0, limit), source: "live" };
    cache.set(key, out);
    return out;
  } catch (err) {
    return { results: offline(q).slice(0, limit), source: "offline", error: err.message };
  }
}

/** Profile for an exact symbol (name, type, sector, industry). */
export async function getProfile(symbol, opts) {
  const sym = String(symbol || "").toUpperCase();
  const { results, source } = await searchSymbols(sym, opts);
  const hit = results.find((r) => r.symbol.toUpperCase() === sym);
  return hit ? { ...hit, source } : { symbol: sym, name: null, type: null, sector: null, industry: null, source: "not found" };
}
