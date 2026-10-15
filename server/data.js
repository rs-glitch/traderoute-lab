// Market data: Yahoo Finance v8 chart API (unofficial, no key, no SLA) with a 15-minute
// in-memory + disk cache, and a real snapshot fallback so the app works offline.
// Every series is labeled with its source ("live" | "cache" | "snapshot") and as-of time.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WATCHLIST, MARKET_INDEXES, SECTOR_ETFS } from "../engine/universe.js";
export { DEFAULT_WATCHLIST, MARKET_INDEXES, SECTOR_ETFS };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "data", "cache");
const SNAP_DIR = join(ROOT, "data", "snapshot");
const TTL_MS = 15 * 60 * 1000;
const SHORT_TTL_MS = 60 * 1000; // quotes and market trends (short ranges) refresh every minute
const ttlFor = (range) => (["1d", "5d", "1mo", "3mo"].includes(range) ? SHORT_TTL_MS : TTL_MS);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TradeRouteLab/0.1";
const SYMBOL = /^[A-Z0-9.\-^=]{1,12}$/;

/** Parse a Yahoo v8 chart payload into { symbol, meta, bars: [{t, o, h, l, c, v}] } (adjusted close in c). */
export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || "Malformed chart response");
  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const bars = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const c = q.close?.[i];
    if (c == null || !Number.isFinite(c)) return; // skip holidays/partial rows
    const k = adj?.[i] && c ? adj[i] / c : 1; // back-adjust OHLC for splits/dividends
    bars.push({ t: ts * 1000, o: (q.open[i] ?? c) * k, h: (q.high[i] ?? c) * k, l: (q.low[i] ?? c) * k, c: c * k, v: q.volume?.[i] ?? 0 });
  });
  const m = r.meta ?? {};
  // During market hours the last daily bar is still forming: keep it out of the bar history
  // (signals and backtests use completed bars only) and expose it as `intraday`.
  const end = m.currentTradingPeriod?.regular?.end;
  const tp = m.currentTradingPeriod ?? {};
  const now = Date.now() / 1000;
  const session = !tp.regular ? "unknown" : now < tp.regular.start ? (tp.pre && now >= tp.pre.start ? "pre-market" : "closed")
    : now < tp.regular.end ? "open" : tp.post && now < tp.post.end ? "after-hours" : "closed";
  let intraday = null;
  if (end && Date.now() / 1000 < end && bars.length && bars.at(-1).t / 1000 >= m.currentTradingPeriod.regular.start) intraday = bars.pop();
  return {
    intraday,
    session,
    symbol: m.symbol, currency: m.currency, exchange: m.fullExchangeName, name: m.longName || m.shortName || m.symbol, type: m.instrumentType,
    last: m.regularMarketPrice, lastTime: (m.regularMarketTime ?? 0) * 1000, prevClose: m.chartPreviousClose,
    bars,
  };
}

const mem = new Map();

/** Daily history for a symbol. Tries live → fresh cache → snapshot. Never throws for known snapshot symbols. */
export async function getHistory(symbol, { range = "5y", fetchImpl = fetch } = {}) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!SYMBOL.test(sym)) throw new Error(`Invalid symbol "${symbol}". Use a ticker like AAPL or SPY.`);
  const key = `${sym}_${range}`;
  const hit = mem.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlFor(range)) return { ...hit.data, source: "cache", fetchedAt: hit.fetchedAt };

  try {
    if (process.env.TRL_OFFLINE === "1") throw new Error("offline mode (TRL_OFFLINE=1)");
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includeAdjustedClose=true`;
    const res = await fetchImpl(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = parseChart(await res.json());
    if (data.bars.length < 1) throw new Error("no bars"); // history length is checked by analysis, not here
    const fetchedAt = Date.now();
    mem.set(key, { data, fetchedAt });
    mkdir(CACHE_DIR, { recursive: true }).then(() => writeFile(join(CACHE_DIR, `${key.replace(/\^/g, "_")}.json`), JSON.stringify({ data, fetchedAt }))).catch(() => {});
    return { ...data, source: "live", fetchedAt };
  } catch (err) {
    const fallbacks = process.env.TRL_OFFLINE === "1" ? [[SNAP_DIR, "snapshot"]] : [[CACHE_DIR, "cache"], [SNAP_DIR, "snapshot"]];
    for (const [dir, source] of fallbacks) {
      const f = join(dir, `${(source === "cache" ? key : sym).replace(/\^/g, "_")}.json`);
      if (existsSync(f)) {
        const saved = JSON.parse(await readFile(f, "utf8"));
        const ageMinutes = Math.round((Date.now() - saved.fetchedAt) / 60000);
        const label = source === "cache" && ageMinutes * 60000 > TTL_MS ? "stale-cache" : source;
        return { ...saved.data, source: label, fetchedAt: saved.fetchedAt, ageMinutes, liveError: err.message };
      }
    }
    throw new Error(`No data for ${sym}: live fetch failed (${err.message}) and there is no snapshot.`);
  }
}

/** Symbols already in the snapshot (file names use "_" for "^"). */
async function snapshotSymbols() {
  const { readdir } = await import("node:fs/promises");
  return existsSync(SNAP_DIR) ? (await readdir(SNAP_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5).replace(/^_/, "^")) : [];
}

/** Save a real snapshot for offline use (`npm run snapshot`): the defaults plus every symbol already in it. */
export async function saveSnapshot(symbols) {
  symbols ??= [...new Set([...DEFAULT_WATCHLIST, ...MARKET_INDEXES.map((x) => x.symbol), ...SECTOR_ETFS.map((x) => x.symbol), ...(await snapshotSymbols())])];
  await mkdir(SNAP_DIR, { recursive: true });
  for (const s of symbols) {
    const d = await getHistory(s);
    if (d.source !== "live") { console.warn(`${s}: not live (${d.source}), skipped`); continue; }
    const { source, fetchedAt, ...data } = d;
    await writeFile(join(SNAP_DIR, `${s.replace(/\^/g, '_')}.json`), JSON.stringify({ data, fetchedAt }));
    console.log(`${s}: ${data.bars.length} bars saved`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "snapshot") await saveSnapshot();
