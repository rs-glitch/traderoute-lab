// MCP server: TradeRoute Lab's engine as agent tools (stdio). Logic lives in engine/tools.js.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeTools } from "../engine/tools.js";
import { getHistory } from "./data.js";
import { searchSymbols, getProfile } from "./search.js";

const T = makeTools((s) => getHistory(s), { search: (q) => searchSymbols(q), getProfile: (s) => getProfile(s) });
const server = new McpServer({ name: "traderoute-lab", version: "0.1.0" });
const wrap = (fn) => async (args) => {
  try { return { content: [{ type: "text", text: JSON.stringify(await fn(args), null, 2) }] }; }
  catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
};
const prefs = z.object({
  capital: z.number().positive(), risk: z.number().int().min(1).max(5), horizonDays: z.number().int().positive(),
  style: z.enum(["passive", "momentum", "trend", "meanReversion", "balanced"]), maxPositionPct: z.number().positive().max(1),
  longOnly: z.boolean(), cashFloorPct: z.number().min(0).max(1), costBps: z.number().min(0),
}).partial();

server.tool("get_prices", "Recent daily prices (split/dividend adjusted) for a ticker, with the data source (live, cache or snapshot) and as-of date.",
  { symbol: z.string(), days: z.number().int().min(1).max(1300).optional() }, wrap(T.get_prices));
server.tool("analyze_ticker", "Statistics (return, volatility, Sharpe, drawdown, beta), a probabilistic forecast (filtered historical simulation: P(up), 90% band, VaR/CVaR), a calibration check of that forecast on history, and walk-forward grades for momentum/trend/mean-reversion signals against a t > 3 multiple-testing hurdle. Education only.",
  { symbol: z.string(), horizon: z.number().int().min(1).max(252).optional(), long_only: z.boolean().optional() }, wrap(T.analyze_ticker));
server.tool("backtest_signal", "Walk-forward backtest of one signal (buyhold, momentum, trend, meanReversion, balanced) with a 1-day execution lag and trading costs. Returns hypothetical CAGR, Sharpe (rf 0), drawdown, hit rate tested against the base rate of up days, and the t-stat vs an exposure-matched buy & hold (|t| > 3 hurdle). Education only.",
  { symbol: z.string(), signal: z.string(), cost_bps: z.number().min(0).optional(), long_only: z.boolean().optional() }, wrap(T.backtest_signal));
server.tool("plan_trades", "Turn user preferences (capital, risk 1-5, horizon, style, max position, long-only) and current holdings into a target portfolio (risk parity + evidence-weighted tilt + target-vol scaling) and ordered trade routes with ATR stops/targets and Monte-Carlo P(target before stop). Paper trading only; not investment advice.",
  { symbols: z.array(z.string()).min(1).max(30), prefs: prefs.optional(), holdings: z.record(z.number()).optional(), cash: z.number().optional() }, wrap(T.plan_trades));

const holdings = z.record(z.number().nonnegative()).describe('Shares per ticker, e.g. {"NVDA": 120, "TLT": 60}');
server.tool("get_portfolio_exposure", "Exposure breakdown of a portfolio: value and share of risk by position, asset class and sector; concentration (top position, top 3, effective number of holdings); volatility; concentration flags. Education only.",
  { holdings, cash: z.number().min(0).optional() }, wrap(T.get_portfolio_exposure));
server.tool("position_risk", "Facts about one position: weight and share of portfolio risk, volatility now vs its 5-year average, forecast odds of a >10% loss over the horizon, VaR/CVaR in dollars, the impact of a 20% drop or its worst drawdown, and signal grades. No recommendation.",
  { symbol: z.string(), holdings, cash: z.number().min(0).optional(), horizon: z.number().int().min(1).max(252).optional() }, wrap(T.position_risk));
server.tool("search_symbols", "Find tickers by company or fund name (e.g. 'Tesla' → TSLA), with type, exchange and sector.",
  { query: z.string().min(1).max(60) }, wrap(T.search_symbols));

await server.connect(new StdioServerTransport());
