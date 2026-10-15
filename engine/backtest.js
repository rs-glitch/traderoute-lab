// Walk-forward backtest with an explicit execution lag and trading costs, plus a skill test.
// Timing: the signal is computed from close t; we trade at close t+1 (next session), so the
// position first earns the return from close t+1 to close t+2. Formally
// strat[t] = pos[t−2] · r[t], where r[t] = px[t]/px[t−1] − 1. That rules out lookahead
// (tested: perturbing future prices never changes past results).

import { simpleReturns, mean, std, sharpe, maxDrawdown, tStat, binomTestP, TRADING_DAYS } from "./stats.js";
import { positions, SIGNALS } from "./signals.js";

export const HURDLE_T = 3.0; // Harvey, Liu & Zhu (2016) multiple-testing hurdle

export function backtest(px, pos, { costBps = 5 } = {}) {
  const r = [0, ...simpleReturns(px)]; // r[t] aligned with px[t]
  const held = new Array(px.length).fill(0);
  const strat = new Array(px.length).fill(0);
  for (let t = 2; t < px.length; t++) {
    held[t] = pos[t - 2];
    const turnover = Math.abs(held[t] - held[t - 1]);
    strat[t] = held[t] * r[t] - turnover * (costBps / 1e4);
  }
  const start = firstActive(pos) + 2;
  const sr = strat.slice(start);
  const br = r.slice(start);
  const eq = [1];
  for (const x of sr) eq.push(eq[eq.length - 1] * (1 + x));
  const beq = [1];
  for (const x of br) beq.push(beq[beq.length - 1] * (1 + x));

  // Directional accuracy on days with a position, tested against the BASE RATE (a long-only
  // position is "right" on every up day, so 50% is the wrong null). p0 = share of positioned
  // days on which a random direction with the same long/short mix would have been right.
  let k = 0;
  let n = 0;
  let nLong = 0;
  let up = 0;
  let nz = 0;
  for (let t = start; t < px.length; t++) {
    if (r[t] !== 0) { nz++; if (r[t] > 0) up++; }
    if (held[t] !== 0 && r[t] !== 0) { n++; if (held[t] > 0) nLong++; if (Math.sign(held[t]) === Math.sign(r[t])) k++; }
  }
  const upRate = nz ? up / nz : 0.5;
  const p0 = n ? (nLong * upRate + (n - nLong) * (1 - upRate)) / n : 0.5;
  // Skill vs an EXPOSURE-MATCHED benchmark (same average exposure, cash earns 0): separates
  // "was out of the market in a bull run" from "picked bad days".
  const expo = mean(held.slice(start).map((h) => Math.abs(h)));
  const diff = sr.map((x, i) => x - expo * br[i]);
  const sd = std(diff);
  const tDiff = sd > 1e-12 ? tStat(diff) : 0;
  const years = sr.length / TRADING_DAYS;
  return {
    days: sr.length,
    start,
    equity: eq,
    benchmarkEquity: beq,
    cagr: eq[eq.length - 1] ** (1 / years) - 1,
    benchmarkCagr: beq[beq.length - 1] ** (1 / years) - 1,
    vol: std(sr) * Math.sqrt(TRADING_DAYS),
    sharpe: sharpe(sr),
    benchmarkSharpe: sharpe(br),
    maxDrawdown: maxDrawdown(eq).mdd,
    exposure: mean(held.slice(start).map((h) => Math.abs(h))),
    trades: held.slice(start).reduce((c, h, i, a) => c + (i > 0 && h !== a[i - 1] ? 1 : 0), 0),
    hitRate: n ? k / n : NaN,
    hitDays: n,
    hitBaseRate: p0,
    hitP: binomTestP(k, n, Math.min(0.999, Math.max(0.001, p0))),
    tVsBenchmark: tDiff,
    benchmark: `buy & hold scaled to ${(expo * 100).toFixed(0)}% average exposure`,
    tAbsolute: tStat(sr),
    verdict: verdictFor(tDiff),
    costBps,
  };
}

/** Symmetric verdicts: the same |t| bar for "better" and "worse". */
export function verdictFor(t) {
  const s = `t = ${t.toFixed(2)}`;
  if (t > HURDLE_T) return { level: "evidence", label: `Edge over exposure-matched buy & hold (${s} > ${HURDLE_T})` };
  if (t < -HURDLE_T) return { level: "negative", label: `Reliably worse than exposure-matched buy & hold (${s})` };
  if (Math.abs(t) > 2) return { level: "weak", label: `Suggestive (${s}), but would not survive multiple testing` };
  return { level: "none", label: `No reliable difference from exposure-matched buy & hold (${s})` };
}

function firstActive(pos) {
  // Start the comparison once every signal could have an opinion (≥ 252 bars of history).
  return Math.min(pos.length - 3, 252);
}

/** Grade every signal on one price series. `trials` = how many hypotheses the user is looking at. */
export function gradeSignals(px, { longOnly = true, costBps = 5, keys = ["momentum", "trend", "meanReversion", "balanced"] } = {}) {
  return keys.map((key) => {
    const bt = backtest(px, positions(key, px, { longOnly }), { costBps });
    const { equity, benchmarkEquity, ...summary } = bt;
    return { key, name: SIGNALS[key].name, about: SIGNALS[key].about, current: positions(key, px, { longOnly }).at(-1), ...summary };
  });
}
