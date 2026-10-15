// Agent tools, implemented once and shared by the MCP server, the chat box and the tests.
// Injected: getBars(symbol) → history (live on the server, fixtures in tests), and optionally
// search(query) / getProfile(symbol) for company lookups.
import { analyzeTicker, planTrades, backtest, positions, SIGNALS, DISCLAIMER } from "./index.js";
import { exposure } from "./exposure.js";
import { positionRisk } from "./position-risk.js";

export function makeTools(getBars, { search = null, getProfile = null } = {}) {
  const load = async (symbols) => Promise.all(symbols.map(async (s) => ({ symbol: s.toUpperCase(), ...(await getBars(s)) })));
  const portfolioData = async (holdings = {}, extra = []) => {
    const syms = [...new Set([...Object.keys(holdings).filter((s) => holdings[s] > 0), ...extra, "SPY"].map((s) => s.toUpperCase()))];
    const out = {};
    await Promise.all(syms.map(async (s) => {
      try {
        const d = await getBars(s);
        const prof = getProfile ? await getProfile(s).catch(() => ({})) : {};
        out[s] = { ...d, sector: prof.sector ?? null, type: d.type ?? prof.type ?? null };
      } catch { /* missing data is reported by exposure() */ }
    }));
    return out;
  };
  const toPositions = (holdings) => Object.entries(holdings ?? {}).map(([symbol, shares]) => ({ symbol: symbol.toUpperCase(), shares: Number(shares) }));

  return {
    get_prices: async ({ symbol, days = 30 }) => {
      const [d] = await load([symbol]);
      return { symbol: d.symbol, source: d.source, asOf: new Date(d.bars.at(-1).t).toISOString().slice(0, 10), last: d.bars.at(-1).c, bars: d.bars.slice(-days), disclaimer: DISCLAIMER };
    },
    analyze_ticker: async ({ symbol, horizon = 21, long_only = true }) => {
      const [d, m] = await load([symbol, "SPY"]);
      const a = analyzeTicker(d.bars, { marketBars: m.bars, horizon, longOnly: long_only });
      const { samplePaths, histogram, fan, ...fc } = a.forecast;
      return { symbol: d.symbol, source: d.source, stats: a.stats, forecast: { ...fc, fanEnd: fan.at(-1) }, calibration: a.calibration, signals: a.signals, disclaimer: DISCLAIMER };
    },
    backtest_signal: async ({ symbol, signal, cost_bps = 5, long_only = true }) => {
      if (!SIGNALS[signal]) throw new Error(`Unknown signal "${signal}". Use one of: ${Object.keys(SIGNALS).join(", ")}.`);
      const [d] = await load([symbol]);
      const px = d.bars.map((b) => b.c);
      const { equity, benchmarkEquity, ...r } = backtest(px, positions(signal, px, { longOnly: long_only }), { costBps: cost_bps });
      return { symbol: d.symbol, signal, window: { from: new Date(d.bars[r.start].t).toISOString().slice(0, 10), to: new Date(d.bars.at(-1).t).toISOString().slice(0, 10) }, ...r, label: "Hypothetical, backtested", disclaimer: DISCLAIMER };
    },
    plan_trades: async ({ symbols, prefs = {}, holdings = {}, cash = null }) => {
      if (!symbols?.length) throw new Error("Provide at least one symbol.");
      const series = await load(symbols);
      const out = planTrades(series, prefs, { holdings, cash });
      return { sources: Object.fromEntries(series.map((s) => [s.symbol, s.source])), ...out, plan: { ...out.plan, correlation: undefined } };
    },
    get_portfolio_exposure: async ({ holdings = {}, cash = 0 }) => {
      const data = await portfolioData(holdings);
      const e = exposure(toPositions(holdings), cash, data);
      return { ...e, sources: Object.fromEntries(Object.entries(data).map(([s, d]) => [s, d.source])), disclaimer: DISCLAIMER };
    },
    position_risk: async ({ symbol, holdings = {}, cash = 0, horizon = 21 }) => {
      const data = await portfolioData(holdings, [symbol]);
      return { ...positionRisk(symbol, toPositions(holdings), cash, data, { horizon }), source: data[String(symbol).toUpperCase()]?.source, disclaimer: DISCLAIMER };
    },
    search_symbols: async ({ query }) => {
      if (!search) throw new Error("Symbol search isn't available in this context.");
      return search(query);
    },
  };
}

/** JSON-schema tool definitions (Claude API + docs). Portfolio tools take holdings from the caller. */
export const TOOL_SCHEMAS = {
  get_prices: { description: "Recent daily adjusted prices for a ticker, with the data source (live, cache or snapshot) and as-of date.", input_schema: { type: "object", properties: { symbol: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 1300 } }, required: ["symbol"] } },
  analyze_ticker: { description: "Statistics (return, volatility, Sharpe, drawdown, beta), a probabilistic forecast (P(up), 90% band, VaR/CVaR) with its historical calibration, and walk-forward grades for momentum/trend/mean-reversion signals against an exposure-matched buy & hold with a |t| > 3 hurdle.", input_schema: { type: "object", properties: { symbol: { type: "string" }, horizon: { type: "integer", minimum: 1, maximum: 252 } }, required: ["symbol"] } },
  backtest_signal: { description: "Hypothetical walk-forward backtest of one signal (buyhold, momentum, trend, meanReversion, balanced) with a 1-day execution lag and costs; hit rate tested against the base rate; t-stat vs exposure-matched buy & hold.", input_schema: { type: "object", properties: { symbol: { type: "string" }, signal: { type: "string", enum: ["buyhold", "momentum", "trend", "meanReversion", "balanced"] } }, required: ["symbol", "signal"] } },
  get_portfolio_exposure: { description: "Exposure breakdown of the user's current portfolio: value and share of risk by position, asset class and sector; concentration (top position, top 3, effective number of holdings); annual volatility; and concentration flags.", input_schema: { type: "object", properties: {}, required: [] } },
  position_risk: { description: "Facts about one position in the user's portfolio: its weight and share of portfolio risk, volatility now vs its 5-year average, forecast odds of a >10% loss over the horizon, VaR/CVaR in dollars, the dollar impact of a 20% drop or a repeat of its worst 5-year drawdown, and signal grades. Use this for 'should I be worried about X' questions.", input_schema: { type: "object", properties: { symbol: { type: "string" }, horizon: { type: "integer", minimum: 1, maximum: 252 } }, required: ["symbol"] } },
  search_symbols: { description: "Find tickers by company or fund name (e.g. 'Tesla' → TSLA), with type, exchange and sector.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
};
