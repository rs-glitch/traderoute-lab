// Exposure breakdown of the user's actual portfolio: where the money is, where the RISK is,
// and how concentrated both are. Risk shares use the same EWMA covariance as the planner.

import { alignReturns } from "./stats.js";
import { ewmaCov, portVol } from "./portfolio.js";
import { classify } from "./classify.js";

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * @param positions [{ symbol, shares }]
 * @param cash      number
 * @param dataBySymbol { SYM: { bars, type?, name?, sector? } }
 */
export function exposure(positions, cash, dataBySymbol) {
  const held = positions.filter((p) => p.shares > 0 && dataBySymbol[p.symbol]?.bars?.length);
  const missing = positions.filter((p) => p.shares > 0 && !dataBySymbol[p.symbol]?.bars?.length).map((p) => p.symbol);
  const excludedShorts = positions.filter((p) => p.shares < 0).map((p) => `${p.symbol} (${p.shares})`);
  const rows = held.map((p) => {
    const d = dataBySymbol[p.symbol];
    const price = d.bars.at(-1).c;
    return { symbol: p.symbol, shares: p.shares, price, value: p.shares * price, ...classify(p.symbol, d) };
  });
  const invested = rows.reduce((a, r) => a + r.value, 0);
  const total = invested + Math.max(0, cash);
  if (total <= 0) throw new Error("Portfolio is empty: import holdings or enter shares first.");
  for (const r of rows) r.weight = r.value / total;

  // Risk: w' Σ w with cash at zero volatility. Needs ≥ 2 aligned series; one holding = 100% of risk.
  let vol = 0;
  if (rows.length === 1) {
    const [only] = rows;
    const C = ewmaCov(alignReturns([dataBySymbol[only.symbol].bars, dataBySymbol[only.symbol].bars]));
    vol = Math.sqrt(C[0][0]) * only.weight;
    only.riskShare = 1;
  } else if (rows.length > 1) {
    const C = ewmaCov(alignReturns(rows.map((r) => dataBySymbol[r.symbol].bars)));
    const w = rows.map((r) => r.weight);
    vol = portVol(C, w);
    const m = C.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
    rows.forEach((r, i) => { r.riskShare = vol > 0 ? (w[i] * m[i]) / (vol * vol) : 0; r.vol = Math.sqrt(C[i][i]); });
  }

  const group = (key) => {
    const g = new Map();
    for (const r of rows) {
      const k = r[key];
      const cur = g.get(k) ?? { name: k, value: 0, weight: 0, riskShare: 0, symbols: [] };
      cur.value += r.value; cur.weight += r.weight; cur.riskShare += r.riskShare ?? 0; cur.symbols.push(r.symbol);
      g.set(k, cur);
    }
    if (key === "assetClass" && cash > 0) g.set("Cash", { name: "Cash", value: cash, weight: cash / total, riskShare: 0, symbols: [] });
    return [...g.values()].sort((a, b) => b.value - a.value).map((x) => ({ ...x, weight: round(x.weight), riskShare: round(x.riskShare) }));
  };

  const byValue = [...rows].sort((a, b) => b.value - a.value);
  const invW = rows.map((r) => r.value / (invested || 1));
  const hhi = invW.reduce((a, x) => a + x * x, 0);
  const byClass = group("assetClass");
  const bySector = group("sector");
  const equityValue = rows.filter((r) => /equity/i.test(r.assetClass)).reduce((a, r) => a + r.value, 0);
  const topRisk = [...rows].sort((a, b) => (b.riskShare ?? 0) - (a.riskShare ?? 0))[0];
  // Sector concentration among single stocks and sector funds only (not broad ETFs, bonds, gold, crypto...).
  const equitySectors = new Map();
  for (const r of rows) {
    if (!/equity/i.test(r.assetClass) || /\(ETF\)|index|markets|Unknown/i.test(r.sector)) continue;
    equitySectors.set(r.sector, (equitySectors.get(r.sector) ?? 0) + r.value);
  }
  const topSector = [...equitySectors.entries()].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))[0];

  const flags = [];
  if (byValue[0] && byValue[0].weight > 0.2) flags.push({ level: "warn", text: `${byValue[0].symbol} is ${(byValue[0].weight * 100).toFixed(0)}% of the portfolio. More than 20% in one position is a common concentration threshold.` });
  if (topRisk && (topRisk.riskShare ?? 0) > 0.35) flags.push({ level: "warn", text: `${topRisk.symbol} accounts for ${(topRisk.riskShare * 100).toFixed(0)}% of the portfolio's recent volatility (its share of variance) while being ${(topRisk.weight * 100).toFixed(0)}% of its value.` });
  if (topSector && equityValue > 0 && topSector.value / equityValue > 0.4) flags.push({ level: "warn", text: `${topSector.name} stocks and sector funds are ${((topSector.value / equityValue) * 100).toFixed(0)}% of your stock holdings. Broad-market ETFs are counted separately, not looked through.` });
  if (rows.length > 1 && 1 / hhi < 5) flags.push({ level: "info", text: `By dollar weights alone, the portfolio is as concentrated as ${(1 / hhi).toFixed(1)} equal-sized positions. That ignores how the holdings move together; the risk shares above account for that.` });
  if (cash / total > 0.3) flags.push({ level: "info", text: `${((cash / total) * 100).toFixed(0)}% is in cash.` });
  const uncl = rows.filter((r) => r.assetClass === "Unclassified").map((r) => r.symbol);
  if (uncl.length) flags.push({ level: "info", text: `Couldn't classify ${uncl.join(", ")}. They're shown as Unclassified.` });
  if (missing.length) flags.push({ level: "info", text: `No price data for ${missing.join(", ")}, so they're excluded from the numbers.` });
  if (excludedShorts.length) flags.push({ level: "warn", text: `Short or negative positions are excluded from these numbers: ${excludedShorts.join(", ")}.` });

  return {
    total, invested, cash,
    positions: byValue.map((r) => ({ ...r, weight: round(r.weight), riskShare: round(r.riskShare ?? 0) })),
    byAssetClass: byClass,
    bySector,
    concentration: {
      top1: round(byValue[0]?.weight ?? 0), top3: round(byValue.slice(0, 3).reduce((a, r) => a + r.weight, 0)),
      hhi: round(hhi), effectiveN: rows.length ? round(1 / hhi, 2) : 0,
    },
    annualVol: round(vol),
    flags,
    missing,
    method: "Values at the last close. Risk share = contribution to portfolio variance from a recent-weighted (EWMA λ 0.94) covariance; cash has zero risk. ETFs are counted by category.",
  };
}
