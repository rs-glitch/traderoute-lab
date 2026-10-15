// The symbols the app knows by default, and the pure parts of the market endpoints.
// Shared by the Node server (live data) and the static demo build (snapshot data), so both answer alike.
// Injected: getHistory(symbol, { range }) → { bars, last, intraday, session, source, ... }.

export const DEFAULT_WATCHLIST = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "JPM", "XOM", "TLT", "GLD"];
export const MARKET_INDEXES = [
  { symbol: "^GSPC", label: "S&P 500" }, { symbol: "^IXIC", label: "Nasdaq" }, { symbol: "^DJI", label: "Dow Jones" },
  { symbol: "^RUT", label: "Russell 2000" }, { symbol: "^VIX", label: "VIX (fear gauge)" }, { symbol: "^TNX", label: "10-yr Treasury yield" },
];
export const SECTOR_ETFS = [
  ["XLK", "Technology"], ["XLC", "Communication"], ["XLY", "Consumer discretionary"], ["XLP", "Consumer staples"], ["XLF", "Financials"],
  ["XLV", "Health care"], ["XLI", "Industrials"], ["XLE", "Energy"], ["XLB", "Materials"], ["XLU", "Utilities"], ["XLRE", "Real estate"],
].map(([symbol, label]) => ({ symbol, label }));

/** Indexes and sector ETFs: last, 1-day and 1-month change, 3-month sparkline. */
export async function marketSummary(getHistory) {
  const one = async ({ symbol, label }, kind) => {
    try {
      const d = await getHistory(symbol, { range: "3mo" });
      const b = d.bars;
      const last = d.intraday?.c ?? d.last ?? b.at(-1).c;
      const prev = d.intraday ? b.at(-1).c : b.at(-2).c;
      const m1 = b.at(-Math.min(22, b.length)).c;
      return { symbol, label, kind, last, prev, change1d: last / prev - 1, change1m: last / m1 - 1, spark: b.slice(-63).map((x) => x.c), session: d.session, source: d.source, asOf: d.lastTime || b.at(-1).t };
    } catch (e) { return { symbol, label, kind, error: e.message }; }
  };
  const [indexes, sectors] = await Promise.all([Promise.all(MARKET_INDEXES.map((x) => one(x, "index"))), Promise.all(SECTOR_ETFS.map((x) => one(x, "sector")))]);
  const session = indexes.find((x) => x.session)?.session ?? "unknown";
  return { indexes, sectors, session, at: Date.now() };
}

/** Latest price and previous close for up to 30 symbols. */
export async function quotes(getHistory, symbols) {
  const syms = symbols.filter(Boolean).slice(0, 30);
  if (!syms.length) throw new Error("Pass ?symbols=AAPL,MSFT");
  const out = await Promise.all(syms.map(async (s) => {
    try {
      const d = await getHistory(s, { range: "5d" });
      const b = d.bars;
      // During market hours the forming bar is split off as `intraday`, so yesterday's close is the last completed bar.
      const prevClose = d.intraday ? b.at(-1)?.c : b.at(-2)?.c;
      return { symbol: d.symbol, last: d.last ?? b.at(-1).c, prevClose, time: d.lastTime || b.at(-1).t, session: d.session, source: d.source };
    } catch (e) { return { symbol: s, error: e.message }; }
  }));
  return { quotes: out, at: Date.now() };
}

/** Offline name search over saved series ({ symbol, name, exchange, type }): ticker prefix or name substring. */
export function searchNames(entries, query) {
  const q = String(query).toLowerCase();
  return entries.filter((d) => d.symbol.toLowerCase().startsWith(q) || (d.name || "").toLowerCase().includes(q))
    .map((d) => ({ symbol: d.symbol, name: d.name, exchange: d.exchange, type: d.type || null, typeLabel: null, sector: null, industry: null, offline: true }));
}
