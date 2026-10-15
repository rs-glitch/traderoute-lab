// Trade routes: an executable, risk-bounded path from current holdings to the target portfolio.
// Each order carries entry (limit), an ATR stop, a target, dollars at risk, a tranche schedule,
// and the Monte-Carlo probability that price reaches the target before the stop within the horizon.

import { atr } from "./stats.js";
import { fhsModel, simulatePaths } from "./forecast.js";

const SLIPPAGE_BPS = 10;
export const REWARD_RISK = 1.5;

/** First-passage probabilities over simulated paths for a long (dir=1) or short (dir=-1) trade. */
export function firstPassage(paths, entry, stop, target, dir = 1) {
  let tgt = 0;
  let stp = 0;
  for (const row of paths) {
    for (let d = 0; d < row.length; d++) {
      const p = row[d];
      if (dir > 0 ? p >= target : p <= target) { tgt++; break; }
      if (dir > 0 ? p <= stop : p >= stop) { stp++; break; }
    }
  }
  const n = paths.length || 1;
  return { pTarget: tgt / n, pStop: stp / n, pNeither: 1 - (tgt + stp) / n };
}

/**
 * @param plan      output of buildPortfolio
 * @param series    [{ symbol, bars }]
 * @param holdings  { SYMBOL: shares } (negative = short)
 * @param cash      current cash
 */
export function buildRoutes(plan, series, { holdings = {}, cash = null, seed = 21, paths = 1000 } = {}) {
  const { prefs, profile } = plan;
  const bySym = new Map(series.map((s) => [s.symbol, s]));
  const last = (sym) => bySym.get(sym).bars.at(-1).c;
  const heldValue = Object.entries(holdings).reduce((a, [s, q]) => a + (bySym.has(s) ? q * last(s) : 0), 0);
  let cashNow = cash ?? Math.max(0, prefs.capital - heldValue);
  const equity = cashNow + heldValue;
  const riskBudget = profile.riskPerTrade * equity;
  const c = prefs.costBps / 1e4;

  // Desired share targets, risk-capped per position.
  const targets = plan.weights.map((w) => {
    const s = bySym.get(w.symbol);
    const price = last(w.symbol);
    const a = atr(s.bars, 14).at(-1) ?? price * 0.02;
    const dir = Math.sign(w.weight) || 1;
    const stopDist = profile.stopAtr * a;
    let shares = Math.trunc((w.weight * equity) / price);
    const byRisk = Math.floor(riskBudget / stopDist);
    const capped = Math.abs(shares) > byRisk;
    if (capped) shares = dir * byRisk;
    return { symbol: w.symbol, price, atr: a, dir, stopDist, shares, capped, weight: w.weight };
  });

  // Also exit anything held that is no longer in the plan.
  for (const [sym, q] of Object.entries(holdings)) {
    if (!plan.weights.some((w) => w.symbol === sym) && bySym.has(sym) && q !== 0) {
      targets.push({ symbol: sym, price: last(sym), atr: 0, dir: 1, stopDist: 0, shares: 0, capped: false, weight: 0 });
    }
  }

  const deltas = targets.map((t) => ({ ...t, current: holdings[t.symbol] ?? 0, delta: t.shares - (holdings[t.symbol] ?? 0) })).filter((t) => t.delta !== 0);
  // Cash-raising orders first (sells and short sales), then cash-consuming ones, largest first.
  const raising = deltas.filter((t) => t.delta < 0).sort((a, b) => a.delta * a.price - b.delta * b.price);
  const using = deltas.filter((t) => t.delta > 0).sort((a, b) => b.delta * b.price - a.delta * a.price);

  const orders = [];
  let step = 0;
  const cashPath = [cashNow];
  for (const t of [...raising, ...using]) {
    const side = t.delta > 0 ? (t.current < 0 ? "cover" : "buy") : t.shares < 0 && t.current <= 0 ? "short" : "sell";
    const limit = t.price * (1 + (t.delta > 0 ? 1 : -1) * SLIPPAGE_BPS / 1e4);
    let qty = Math.abs(t.delta);
    if (t.delta > 0) {
      const affordable = Math.floor(cashNow / (limit * (1 + c)));
      if (affordable < qty) qty = Math.max(0, affordable);
      if (qty === 0) continue;
      cashNow -= qty * limit * (1 + c);
    } else {
      cashNow += qty * limit * (1 - c);
    }
    cashPath.push(cashNow);

    const opening = side === "buy" || side === "short";
    let route = null;
    if (opening) {
      const dir = side === "buy" ? 1 : -1;
      const stop = limit - dir * t.stopDist;
      const target = limit + dir * REWARD_RISK * t.stopDist;
      const sims = simulatePaths(fhsModel(bySym.get(t.symbol).bars.map((b) => b.c)), { horizon: prefs.horizonDays, paths, seed: seed + orders.length });
      const fp = firstPassage(sims, limit, stop, target, dir);
      const positionShares = Math.abs(t.shares);
      const n = Math.min(profile.tranches, qty);
      const base = Math.floor(qty / n);
      const tranches = Array.from({ length: n }, (_, k) => ({ day: k * Math.max(1, Math.floor(prefs.horizonDays / (n * 2))), shares: k === n - 1 ? qty - base * (n - 1) : base }));
      route = {
        stop, target, rewardRisk: REWARD_RISK,
        riskDollars: positionShares * t.stopDist,
        rewardDollars: positionShares * REWARD_RISK * t.stopDist,
        ...fp,
        horizonDays: prefs.horizonDays,
        tranches,
        cappedByRisk: t.capped,
      };
    }
    orders.push({
      step: ++step, symbol: t.symbol, side, shares: qty, limit, price: t.price, notional: qty * limit,
      estCost: qty * limit * c, targetShares: t.shares, currentShares: t.current, route,
      why: explain(t, side, profile),
    });
  }

  const turnover = orders.reduce((a, o) => a + o.notional, 0);
  return {
    equity, riskBudget, orders,
    cashAfter: cashNow,
    minCashDuringRoute: Math.min(...cashPath),
    turnover,
    estCosts: orders.reduce((a, o) => a + o.estCost, 0),
    note: "Paper trading only. Education and simulation, not investment advice.",
  };
}

function explain(t, side, profile) {
  if (side === "sell" && t.shares === 0) return "Not in the target portfolio. Exit to free capital.";
  if (side === "sell" || side === "cover") return `Reduce to target (${t.shares} shares).`;
  const risk = `stop ${profile.stopAtr}× ATR ($${t.stopDist.toFixed(2)}/share)`;
  return `${(t.weight * 100).toFixed(1)}% target weight; ${risk}${t.capped ? `; size capped so a stop-out loses ≤ ${(profile.riskPerTrade * 100).toFixed(1)}% of equity` : ""}.`;
}
