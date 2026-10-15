// Probabilistic forecasts by filtered historical simulation (FHS).
// 1. Standardize history: z_t = (r_t − μ) / σ_{t−1}, where σ is RiskMetrics EWMA (λ = 0.94).
// 2. Simulate: draw z* iid from history, r = μ_s + σ z*, and update σ² ← λσ² + (1−λ)r².
// Residuals are re-centered (mean 0), so the bootstrap adds no hidden drift. Drift defaults to
// 0: an asset's own past mean is a weak predictor (Welch & Goyal 2008), and today's watchlist
// is picked with hindsight. Output is a distribution, never a target.

import { logReturns, ewmaVol, mean, quantile } from "./stats.js";
import { mulberry32 } from "./rng.js";

export const DRIFT_SHRINK = 0; // weight on the asset's own historical mean (0 = neutral)
export const LAMBDA = 0.94;
const WARM = 20;

/** Prepare the standardized residual pool from closes (uses ONLY the given closes). */
export function fhsModel(closes) {
  const r = logReturns(closes);
  const sig = ewmaVol(r, LAMBDA, WARM);
  const mu = mean(r);
  const z = [];
  for (let t = WARM; t < r.length; t++) z.push((r[t] - mu) / sig[t - 1]);
  const zm = mean(z);
  for (let i = 0; i < z.length; i++) z[i] -= zm; // re-center: no drift hidden in the residual pool
  return { z, mu, drift: DRIFT_SHRINK * mu, sigma0: sig[sig.length - 1], last: closes[closes.length - 1] };
}

/**
 * Simulate `paths` price paths `horizon` days ahead.
 * Returns Float64Array rows of prices (without the starting price).
 */
export function simulatePaths(model, { horizon = 21, paths = 2000, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const out = new Array(paths);
  const { z, drift, sigma0, last } = model;
  for (let p = 0; p < paths; p++) {
    const row = new Float64Array(horizon);
    let v = sigma0 * sigma0;
    let logP = Math.log(last);
    for (let d = 0; d < horizon; d++) {
      const s = Math.sqrt(v);
      const r = drift + s * z[Math.floor(rand() * z.length)];
      logP += r;
      row[d] = Math.exp(logP);
      v = LAMBDA * v + (1 - LAMBDA) * r * r;
    }
    out[p] = row;
  }
  return out;
}

const QS = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Forecast summary for the UI/API: fan quantiles per day, terminal stats, histogram, sample paths. */
export function forecast(closes, { horizon = 21, paths = 2000, seed = 7 } = {}) {
  const model = fhsModel(closes);
  const sims = simulatePaths(model, { horizon, paths, seed });
  const fan = [];
  for (let d = 0; d < horizon; d++) {
    const col = sims.map((row) => row[d]).sort((a, b) => a - b);
    fan.push(Object.fromEntries(QS.map((q) => [`p${Math.round(q * 100)}`, quantile(col, q)])));
  }
  const terminal = sims.map((row) => row[horizon - 1] / model.last - 1).sort((a, b) => a - b);
  const var95 = -quantile(terminal, 0.05);
  const tail = terminal.slice(0, Math.max(1, Math.floor(terminal.length * 0.05)));
  const lo = terminal[0];
  const hi = terminal[terminal.length - 1];
  const bins = 30;
  const w = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: 0 }));
  for (const x of terminal) hist[Math.min(bins - 1, Math.floor((x - lo) / w))].count++;
  return {
    horizon, paths, seed, last: model.last,
    sigmaDaily: model.sigma0,
    annVolNow: model.sigma0 * Math.sqrt(252),
    driftDaily: model.drift,
    fan,
    probUp: terminal.filter((x) => x > 0).length / terminal.length,
    expectedReturn: mean(terminal),
    median: quantile(terminal, 0.5),
    var95,
    cvar95: -mean(tail),
    band90: [quantile(terminal, 0.05), quantile(terminal, 0.95)],
    histogram: hist,
    samplePaths: sims.slice(0, 30).map((r) => Array.from(r)),
  };
}

/**
 * Calibration check (the plan's falsifier): at rolling origins, forecast using ONLY data up to
 * the origin, then test whether the realized price h days later fell inside the central band.
 * Returns empirical coverage; a well-calibrated 90% band should cover ≈ 90%.
 */
export function calibrate(closes, { horizon = 21, step = 10, minHistory = 252, paths = 400, level = 0.9, seed = 11 } = {}) {
  const loQ = (1 - level) / 2;
  let hits = 0;
  let n = 0;
  let below = 0;
  let above = 0;
  for (let o = minHistory; o + horizon < closes.length; o += step) {
    const hist = closes.slice(0, o + 1);
    const model = fhsModel(hist);
    const sims = simulatePaths(model, { horizon, paths, seed: seed + o });
    const col = sims.map((r) => r[horizon - 1]).sort((a, b) => a - b);
    const lo = quantile(col, loQ);
    const hi = quantile(col, 1 - loQ);
    const actual = closes[o + horizon];
    n++;
    if (actual < lo) below++;
    else if (actual > hi) above++;
    else hits++;
  }
  return { level, horizon, origins: n, coverage: n ? hits / n : NaN, below: n ? below / n : NaN, above: n ? above / n : NaN, note: "Origins overlap when step < horizon, so they are not independent." };
}
