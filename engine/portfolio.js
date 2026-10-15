// Preferences → target portfolio.
// Base: equal risk contribution (ERC) from an EWMA covariance, so no asset dominates risk.
// Tilt: the style's current signal, weighted by the EVIDENCE for that signal on that asset
// (backtest t-stat vs buy & hold, clamp(t/3, 0, 1)). Without evidence there is no tilt.
// Dial: if the unlevered book falls short of the target vol, tilt toward higher-vol assets (γ).
// Scale: to the profile's target volatility, never above 1× gross (no leverage); caps leave cash.

import { alignReturns, TRADING_DAYS } from "./stats.js";
import { positions, STYLE_SIGNAL, SIGNALS } from "./signals.js";
import { backtest, HURDLE_T } from "./backtest.js";

export const RISK_PROFILES = [
  { level: 1, label: "Very conservative", targetVol: 0.05, stopAtr: 1.5, riskPerTrade: 0.01, tranches: 3 },
  { level: 2, label: "Conservative", targetVol: 0.08, stopAtr: 2.0, riskPerTrade: 0.0125, tranches: 3 },
  { level: 3, label: "Moderate", targetVol: 0.12, stopAtr: 2.5, riskPerTrade: 0.015, tranches: 2 },
  { level: 4, label: "Growth", targetVol: 0.16, stopAtr: 3.0, riskPerTrade: 0.02, tranches: 1 },
  { level: 5, label: "Aggressive", targetVol: 0.22, stopAtr: 3.5, riskPerTrade: 0.025, tranches: 1 },
];

export const DEFAULT_PREFS = Object.freeze({
  capital: 100000, risk: 3, horizonDays: 21, style: "balanced", maxPositionPct: 0.25,
  longOnly: true, cashFloorPct: 0.02, costBps: 5, tiltStrength: 1.5,
});

export function normalizePrefs(p = {}) {
  const x = { ...DEFAULT_PREFS, ...p };
  const bad = (m) => { throw new Error(`Invalid preference: ${m}`); };
  if (!(x.capital > 0)) bad("capital must be > 0");
  if (![1, 2, 3, 4, 5].includes(Number(x.risk))) bad("risk must be 1–5");
  if (!STYLE_SIGNAL[x.style]) bad(`style must be one of ${Object.keys(STYLE_SIGNAL).join(", ")}`);
  if (!(x.maxPositionPct > 0 && x.maxPositionPct <= 1)) bad("maxPositionPct must be in (0, 1]");
  return { ...x, risk: Number(x.risk), horizonDays: Math.max(1, Math.round(x.horizonDays)) };
}

/** Annualized EWMA covariance of aligned daily returns (assets × T). */
export function ewmaCov(R, lambda = 0.94, warm = 60) {
  const k = R.length;
  const T = R[0].length;
  const C = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    let s = 0;
    for (let t = 0; t < warm; t++) s += R[i][t] * R[j][t];
    C[i][j] = s / warm;
  }
  for (let t = warm; t < T; t++) for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
    C[i][j] = lambda * C[i][j] + (1 - lambda) * R[i][t] * R[j][t];
    C[j][i] = C[i][j];
  }
  return C.map((row) => row.map((v) => v * TRADING_DAYS));
}

const mv = (C, w) => C.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
export const portVol = (C, w) => Math.sqrt(Math.max(0, w.reduce((s, wi, i) => s + wi * mv(C, w)[i], 0)));

/**
 * Equal-risk-contribution (ERC) long-only weights by cyclical coordinate descent on the convex
 * problem min ½wᵀΣw − Σ bᵢ ln wᵢ (Griveau-Billion, Richard & Roncalli 2013), then normalized.
 * Each coordinate step has a closed form, so it converges even with negative correlations.
 */
export function ercWeights(C, iters = 300) {
  const n = C.length;
  const b = 1 / n;
  const w = C.map((row, i) => 1 / Math.sqrt(row[i]));
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let j = 0; j < n; j++) if (j !== i) a += C[i][j] * w[j];
      w[i] = (-a + Math.sqrt(a * a + 4 * C[i][i] * b)) / (2 * C[i][i]);
    }
  }
  const s = w.reduce((x, y) => x + y, 0);
  return w.map((x) => x / s);
}

/** Cap |w_i| at `cap`, redistributing the excess to uncapped names in proportion. */
export function capWeights(w, cap) {
  let out = [...w];
  for (let it = 0; it < 50; it++) {
    const gross = out.reduce((a, x) => a + Math.abs(x), 0);
    let excess = 0;
    const free = [];
    out = out.map((x, i) => {
      if (Math.abs(x) > cap * gross + 1e-12) { excess += Math.abs(x) - cap * gross; return Math.sign(x) * cap * gross; }
      free.push(i);
      return x;
    });
    if (excess < 1e-12 || !free.length) break;
    const freeGross = free.reduce((a, i) => a + Math.abs(out[i]), 0) || 1;
    for (const i of free) out[i] += Math.sign(out[i] || 1) * excess * (Math.abs(out[i]) / freeGross);
  }
  return out;
}

/**
 * Build the target portfolio. `series` = [{ symbol, bars }]. Pure and deterministic.
 */
export function buildPortfolio(series, prefsIn) {
  const prefs = normalizePrefs(prefsIn);
  const profile = RISK_PROFILES[prefs.risk - 1];
  if (series.length < 1) throw new Error("Add at least one ticker to the watchlist.");
  const R = alignReturns(series.map((s) => s.bars));
  const C = ewmaCov(R);
  const base = series.length === 1 ? [1] : ercWeights(C);
  const sigKey = STYLE_SIGNAL[prefs.style];

  const rows = series.map((s, i) => {
    const px = s.bars.map((b) => b.c);
    const signal = positions(sigKey, px, { longOnly: false }).at(-1);
    let t = 0;
    if (sigKey !== "buyhold") t = backtest(px, positions(sigKey, px, { longOnly: prefs.longOnly }), { costBps: prefs.costBps }).tVsBenchmark;
    // Tilt only on real evidence: 0 below t = 2, ramps to 1 at the t = 3 hurdle.
    const evidence = Math.min(1, Math.max(0, (t - 2) / (HURDLE_T - 2)));
    let tilt = sigKey === "buyhold" ? 1 : 1 + prefs.tiltStrength * signal * evidence;
    if (prefs.longOnly) tilt = Math.max(0, tilt);
    return { symbol: s.symbol, base: base[i], signal, t, evidence, tilt, raw: base[i] * tilt };
  });

  const indivVol = C.map((row, i) => Math.sqrt(row[i]));
  // Weights for a given "risk appetite" exponent γ: tilt toward higher-volatility assets.
  const shape = (gamma) => {
    const raw = rows.map((r, i) => r.raw * indivVol[i] ** gamma);
    const g0 = raw.reduce((a, x) => a + Math.abs(x), 0) || 1;
    // If n · cap < 1 the caps can't all be met at full investment: the remainder stays in cash.
    return capWeights(raw.map((x) => x / g0), prefs.maxPositionPct).map((x) => Math.sign(x) * Math.min(Math.abs(x), prefs.maxPositionPct));
  };
  const maxGross = 1 - prefs.cashFloorPct;
  let gamma = 0;
  let w = shape(0);
  // Without leverage, a diversified book may sit below the target vol. If so, raise γ
  // (bisection) until the fully invested book reaches the target, or γ = 4.
  if (portVol(C, w) * maxGross < profile.targetVol) {
    let lo = 0;
    let hi = 4;
    if (portVol(C, shape(hi)) * maxGross <= profile.targetVol) { gamma = hi; } else {
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        if (portVol(C, shape(mid)) * maxGross < profile.targetVol) lo = mid; else hi = mid;
      }
      gamma = hi;
    }
    w = shape(gamma);
  }
  const vol = portVol(C, w);
  const gross1 = w.reduce((a, x) => a + Math.abs(x), 0) || 1;
  const scale = Math.min(maxGross / gross1, vol > 0 ? profile.targetVol / vol : 1);
  w = w.map((x) => Math.sign(x) * Math.min(Math.abs(x * scale), prefs.maxPositionPct));

  const m = mv(C, w);
  const pv = portVol(C, w);
  const weighted = w.reduce((a, wi, i) => a + Math.abs(wi) * indivVol[i], 0);
  const signalName = SIGNALS[sigKey].name;

  return {
    prefs, profile,
    weights: rows.map((r, i) => ({
      symbol: r.symbol,
      weight: w[i],
      dollars: w[i] * prefs.capital,
      baseWeight: r.base,
      signal: r.signal,
      tStat: r.t,
      evidence: r.evidence,
      tilt: r.tilt,
      vol: indivVol[i],
      riskContribution: pv > 0 ? (w[i] * m[i]) / (pv * pv) : 0,
      rationale: rationale(r, signalName, sigKey),
    })),
    cash: 1 - w.reduce((a, x) => a + x, 0),
    gross: w.reduce((a, x) => a + Math.abs(x), 0),
    expectedVol: pv,
    targetVol: profile.targetVol,
    riskTiltGamma: gamma,
    reachesTarget: Math.abs(pv - profile.targetVol) < 0.005,
    diversificationRatio: pv > 0 ? weighted / pv : 1,
    correlation: C.map((row, i) => row.map((c, j) => c / (indivVol[i] * indivVol[j]))),
    symbols: series.map((s) => s.symbol),
  };
}

function rationale(r, signalName, key) {
  const base = `${(r.base * 100).toFixed(1)}% risk-parity base`;
  if (key === "buyhold") return `${base}; passive style, no tilt.`;
  const dir = r.signal > 0.01 ? "bullish" : r.signal < -0.01 ? "bearish" : "neutral";
  if (r.evidence === 0) return `${base}; ${signalName} is ${dir} but has no historical edge here (t = ${r.t.toFixed(2)}), so no tilt.`;
  return `${base} × ${r.tilt.toFixed(2)} tilt: ${signalName} is ${dir}, evidence weight ${(r.evidence * 100).toFixed(0)}% (t = ${r.t.toFixed(2)}).`;
}
