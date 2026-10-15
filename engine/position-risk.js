// "Should I be worried about my X position?": the facts behind that question, with no verdict.
// Size, share of risk, forecast loss odds, what a drawdown would cost, and how the signals grade.

import { exposure } from "./exposure.js";
import { describe } from "./stats.js";
import { forecast } from "./forecast.js";
import { gradeSignals } from "./backtest.js";

export function positionRisk(symbol, positions, cash, dataBySymbol, { horizon = 21, marketSymbol = "SPY" } = {}) {
  const sym = String(symbol).toUpperCase();
  const pos = positions.find((p) => p.symbol === sym && p.shares > 0);
  const d = dataBySymbol[sym];
  if (!d?.bars?.length) throw new Error(`No price data for ${sym}. Add it to the watchlist first.`);
  const ex = exposure(positions, cash, dataBySymbol);
  const row = ex.positions.find((p) => p.symbol === sym);
  const px = d.bars.map((b) => b.c);
  const st = describe(d.bars, dataBySymbol[marketSymbol]?.bars && sym !== marketSymbol ? dataBySymbol[marketSymbol].bars : null);
  const fc = forecast(px, { horizon, paths: 2000, seed: 7 });
  const value = row?.value ?? 0;
  const pLoss10 = probBelow(fc, -0.1);
  const signals = px.length >= 300 ? gradeSignals(px) : [];
  return {
    symbol: sym,
    held: !!pos,
    shares: pos?.shares ?? 0,
    value,
    weight: row?.weight ?? 0,
    riskShare: row?.riskShare ?? 0,
    assetClass: row?.assetClass,
    sector: row?.sector,
    volNow: st.volNow, volAvg5y: st.vol, volElevated: st.volNow > st.vol * 1.2,
    beta: st.beta ?? null,
    maxDrawdown5y: st.maxDrawdown,
    return1y: st.return1y,
    forecast: { horizonDays: horizon, probUp: fc.probUp, probLossOver10pct: pLoss10, band90: fc.band90, var95: fc.var95, cvar95: fc.cvar95 },
    dollars: {
      var95: value * fc.var95, cvar95: value * fc.cvar95,
      ifDrops20pct: value * 0.2, ifDrops20pctOfPortfolio: ex.total ? (value * 0.2) / ex.total : 0,
      ifRepeatsWorstDrawdown: value * Math.abs(st.maxDrawdown),
    },
    signals: signals.map((s) => ({ name: s.name, current: s.current, verdict: s.verdict.label })),
    portfolioTotal: ex.total,
    note: "Facts, not a recommendation. Forecasts are distributions from filtered historical simulation (drift 0). Education only.",
  };
}

/** P(return < x) at the horizon, read off the terminal histogram. */
function probBelow(fc, x) {
  const total = fc.histogram.reduce((a, b) => a + b.count, 0) || 1;
  let n = 0;
  for (const b of fc.histogram) {
    if (b.to <= x) n += b.count;
    else if (b.from < x) n += b.count * ((x - b.from) / (b.to - b.from));
  }
  return n / total;
}
