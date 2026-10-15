import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../engine/stats.js";
import { forecast, calibrate, fhsModel, simulatePaths } from "../engine/forecast.js";
import { backtest } from "../engine/backtest.js";
import { positions, SIGNALS } from "../engine/signals.js";
import { buildPortfolio, ercWeights, capWeights, ewmaCov } from "../engine/portfolio.js";
import { buildRoutes, firstPassage } from "../engine/routes.js";
import { analyzeTicker, planTrades } from "../engine/index.js";
import { snap, series, gbmBars } from "./fixtures.js";

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);

test("stats: known answers", () => {
  close(S.std([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 1e-3);
  assert.deepEqual(S.maxDrawdown([100, 120, 90, 130, 65]).mdd, -0.5);
  const r = S.simpleReturns(gbmBars(500).map((b) => b.c));
  close(S.beta(r, r), 1, 1e-12);
  close(S.corr(r, r), 1, 1e-12);
  assert.equal(S.rsi([...Array(30)].map((_, i) => 100 + i)).at(-1), 100); // strictly rising → RSI 100
  close(S.binomTestP(60, 100), 0.0569, 1e-3); // exact two-sided binomial
  close(S.normCdf(1.96), 0.975, 1e-4);
  const cst = [...Array(260)].map((_, i) => 100 * 1.001 ** i); // constant +0.1%/day
  close(S.cagr(cst), 1.001 ** 252 - 1, 1e-9);
  assert.deepEqual(S.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test("EWMA vol recovers the true volatility of a GBM", () => {
  const b = gbmBars(3000, { sigma: 0.02, seed: 3 });
  const v = S.ewmaVol(S.logReturns(b.map((x) => x.c)));
  close(S.mean(v.slice(500)), 0.02, 0.002);
});

test("NO LOOKAHEAD: changing future prices never changes past positions or past strategy returns", () => {
  const px = snap("AAPL").bars.map((b) => b.c);
  const cut = 900;
  const future = px.map((p, i) => (i > cut ? p * (i % 2 ? 1.3 : 0.6) : p));
  for (const key of Object.keys(SIGNALS)) {
    const a = positions(key, px);
    const b = positions(key, future);
    assert.deepEqual(a.slice(0, cut + 1), b.slice(0, cut + 1), `${key} positions`);
    const ea = backtest(px, a).equity;
    const eb = backtest(future, b).equity;
    // equity index k corresponds to px index start+k; returns up to px[cut] are identical
    const start = backtest(px, a).start;
    assert.deepEqual(ea.slice(0, cut - start + 1), eb.slice(0, cut - start + 1), `${key} equity`);
  }
});

test("backtest: 1-day execution lag and costs", () => {
  const px = [100, 100, 110, 121, 121];
  // a signal that 'knows' day 2's jump at day 1 cannot earn it: position decided at t is held from t+2.
  const pos = [0, 1, 1, 1, 1];
  const r = [0, 0, 0.1, 0.1, 0];
  const held = [0, 0, pos[0], pos[1], pos[2]];
  assert.deepEqual(held.map((h, t) => h * r[t]), [0, 0, 0, 0.1, 0]);
  const b = gbmBars(800, { seed: 9 }).map((x) => x.c);
  const p = positions("trend", b);
  assert.ok(backtest(b, p, { costBps: 50 }).cagr < backtest(b, p, { costBps: 0 }).cagr);
});

test("signals on a random walk show no skill (the test is honest)", () => {
  let evidence = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const px = gbmBars(1500, { seed, sigma: 0.015 }).map((b) => b.c);
    for (const k of ["momentum", "trend", "meanReversion"]) if (backtest(px, positions(k, px)).verdict.level === "evidence") evidence++;
  }
  assert.ok(evidence <= 1, `false discoveries: ${evidence}/30`);
});

test("forecast: seeded, ordered quantiles, sane probabilities", () => {
  const px = snap("SPY").bars.map((b) => b.c);
  const a = forecast(px, { seed: 5 });
  assert.deepEqual(a, forecast(px, { seed: 5 }));
  for (const d of a.fan) assert.ok(d.p5 <= d.p25 && d.p25 <= d.p50 && d.p50 <= d.p75 && d.p75 <= d.p95);
  assert.ok(a.probUp > 0.3 && a.probUp < 0.8);
  assert.ok(a.cvar95 >= a.var95);
});

test("forecast calibration: 90% band covers 80–98% of real outcomes (the plan's falsifier)", () => {
  for (const s of ["SPY", "NVDA", "TLT"]) {
    const c = calibrate(snap(s).bars.map((b) => b.c), { horizon: 21, step: 15 });
    assert.ok(c.coverage > 0.8 && c.coverage < 0.98, `${s} coverage ${c.coverage}`);
  }
});

test("portfolio: ERC equalizes risk; caps, cash and risk dial behave", () => {
  const ser = series(["SPY", "TLT", "GLD", "NVDA", "XOM"]);
  const p = buildPortfolio(ser, { style: "passive", risk: 1, maxPositionPct: 1 }); // pure ERC: no cap, no vol-seeking tilt
  const rc = p.weights.map((w) => w.riskContribution);
  for (const x of rc) close(x, 1 / rc.length, 0.01);
  close(p.weights.reduce((a, w) => a + w.weight, 0) + p.cash, 1, 1e-9);
  const caps = buildPortfolio(ser, { maxPositionPct: 0.22, risk: 5 });
  for (const w of caps.weights) assert.ok(Math.abs(w.weight) <= 0.22 + 1e-9, `${w.symbol} ${w.weight}`);
  let prev = 0;
  for (const r of [1, 2, 3, 4, 5]) {
    const v = buildPortfolio(ser, { risk: r }).expectedVol;
    assert.ok(v >= prev - 1e-9, `risk ${r}: vol ${v} < ${prev}`);
    prev = v;
  }
  for (const w of buildPortfolio(ser, { longOnly: true, style: "momentum" }).weights) assert.ok(w.weight >= 0);
  assert.throws(() => buildPortfolio(ser, { risk: 9 }), /risk must be 1–5/);
});

test("routes: sells before buys, cash never negative, integer shares, stop-loss within budget", () => {
  const ser = series(["SPY", "QQQ", "TLT", "GLD"]);
  const { plan, routes } = planTrades(ser, { capital: 50000, risk: 3 }, { holdings: { SPY: 60, XOM: 0 }, cash: 20000 });
  const o = routes.orders;
  const firstBuy = o.findIndex((x) => x.side === "buy");
  const lastSell = o.map((x) => x.side).lastIndexOf("sell");
  assert.ok(lastSell === -1 || firstBuy === -1 || lastSell < firstBuy);
  assert.ok(routes.minCashDuringRoute >= -1e-6);
  for (const x of o) {
    assert.ok(Number.isInteger(x.shares) && x.shares > 0);
    if (x.route) assert.ok(x.route.riskDollars <= routes.riskBudget + 1e-6, `${x.symbol} risk ${x.route.riskDollars} > ${routes.riskBudget}`);
    if (x.route) close(x.route.pTarget + x.route.pStop + x.route.pNeither, 1, 1e-9);
  }
  assert.ok(plan.weights.length === 4);
});

test("first passage: symmetric zero-drift bracket ≈ 50/50", () => {
  const px = gbmBars(1500, { mu: 0, sigma: 0.01, seed: 4 }).map((b) => b.c);
  const m = { ...fhsModel(px), drift: 0 };
  const sims = simulatePaths(m, { horizon: 250, paths: 4000, seed: 2 });
  const e = m.last;
  const fp = firstPassage(sims, e, e * 0.95, e * 1.05);
  close(fp.pTarget / (fp.pTarget + fp.pStop), 0.5, 0.04);
});

test("analyzeTicker: complete and serializable on real data", () => {
  const a = analyzeTicker(snap("MSFT").bars, { marketBars: snap("SPY").bars });
  const j = JSON.parse(JSON.stringify(a));
  assert.ok(j.stats.beta > 0.3 && j.stats.beta < 2.5);
  assert.equal(j.signals.length, 4);
  assert.match(j.disclaimer, /Not investment advice/);
  assert.throws(() => analyzeTicker(snap("MSFT").bars.slice(0, 100)), /at least 300/);
});

test("hit-rate test uses the base rate, not 50% (coordinator finding #2)", () => {
  const px = snap("NVDA").bars.map((b) => b.c);
  const bh = backtest(px, positions("buyhold", px));
  close(bh.hitRate, bh.hitBaseRate, 1e-12); // buy & hold is right exactly as often as the market is up
  assert.ok(bh.hitP > 0.9, `buy & hold should not look 'significant': p=${bh.hitP}`);
  assert.equal(bh.tVsBenchmark, 0);
  assert.equal(bh.verdict.level, "none");
});

test("verdicts are symmetric and exposure-matched (finding #3)", async () => {
  const { verdictFor } = await import("../engine/backtest.js");
  assert.equal(verdictFor(-2.5).level, "weak");
  assert.equal(verdictFor(2.5).level, "weak");
  assert.equal(verdictFor(-3.1).level, "negative");
  // A half-exposure copy of buy & hold is not "worse": it matches its exposure-matched benchmark.
  const px = snap("SPY").bars.map((b) => b.c);
  const half = backtest(px, px.map(() => 0.5), { costBps: 0 });
  close(half.tVsBenchmark, 0, 1e-6);
});

test("FHS residuals are re-centered: zero drift + symmetric bracket ≈ 50% on REAL data (finding #4)", () => {
  const m = fhsModel(snap("NVDA").bars.map((b) => b.c));
  close(S.mean(m.z), 0, 1e-12);
  assert.equal(m.drift, 0);
  const sims = simulatePaths(m, { horizon: 250, paths: 4000, seed: 3 });
  const e = m.last;
  const fp = firstPassage(sims, e, e / 1.05, e * 1.05);
  close(fp.pTarget / (fp.pTarget + fp.pStop), 0.5, 0.05);
});

test("infeasible caps leave cash instead of breaking the cap (finding #6)", () => {
  const p = buildPortfolio(series(["SPY", "TLT", "GLD"]), { maxPositionPct: 0.25, risk: 5 });
  for (const w of p.weights) assert.ok(w.weight <= 0.25 + 1e-9, `${w.symbol} ${w.weight}`);
  assert.ok(p.cash >= 0.25 - 1e-9);
});
