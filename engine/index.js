// Public engine API (pure, zero deps): the browser, the servers and the tests all use this.
import { describe, alignReturns, corr } from "./stats.js";
import { forecast, calibrate } from "./forecast.js";
import { gradeSignals, backtest, HURDLE_T } from "./backtest.js";
import { positions, SIGNALS, STYLE_SIGNAL } from "./signals.js";
import { buildPortfolio, RISK_PROFILES, DEFAULT_PREFS, normalizePrefs } from "./portfolio.js";
import { buildRoutes, firstPassage } from "./routes.js";

export { describe, forecast, calibrate, gradeSignals, backtest, positions, SIGNALS, STYLE_SIGNAL, buildPortfolio, buildRoutes, firstPassage, RISK_PROFILES, DEFAULT_PREFS, normalizePrefs, HURDLE_T, alignReturns, corr };

export const DISCLAIMER = "Education and simulation only. Not investment advice. Past performance does not predict future results.";

/** Everything about one ticker: stats, forecast distribution, calibration, graded signals. */
export function analyzeTicker(bars, { marketBars = null, horizon = 21, longOnly = true, costBps = 5, seed = 7, withCalibration = true } = {}) {
  if (!bars || bars.length < 300) throw new Error(`Need at least 300 daily bars for analysis; got ${bars?.length ?? 0}.`);
  const px = bars.map((b) => b.c);
  return {
    stats: describe(bars, marketBars),
    forecast: forecast(px, { horizon, seed }),
    calibration: withCalibration ? calibrate(px, { horizon }) : null,
    signals: gradeSignals(px, { longOnly, costBps }),
    disclaimer: DISCLAIMER,
  };
}

/** Preferences + holdings → target portfolio + trade routes. */
export function planTrades(series, prefs, { holdings = {}, cash = null, seed = 21 } = {}) {
  const plan = buildPortfolio(series, prefs);
  const routes = buildRoutes(plan, series, { holdings, cash, seed });
  return { plan, routes, disclaimer: DISCLAIMER };
}
