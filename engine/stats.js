// Descriptive statistics and indicators. Pure functions on arrays.
// Conventions: daily data, 252 trading days/year, simple returns unless named "log".

export const TRADING_DAYS = 252;

export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);
/** Sample standard deviation (n − 1). */
export function std(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

export const simpleReturns = (px) => px.slice(1).map((p, i) => p / px[i] - 1);
export const logReturns = (px) => px.slice(1).map((p, i) => Math.log(p / px[i]));

/** Compound annual growth rate over the whole series. */
export const cagr = (px) => (px[px.length - 1] / px[0]) ** (TRADING_DAYS / (px.length - 1)) - 1;
export const annVol = (r) => std(r) * Math.sqrt(TRADING_DAYS);
/** Annualized Sharpe of daily simple returns vs a daily risk-free rate (default 0). */
export const sharpe = (r, rfDaily = 0) => {
  const ex = r.map((x) => x - rfDaily);
  return (mean(ex) / std(ex)) * Math.sqrt(TRADING_DAYS);
};
export function sortino(r) {
  const down = r.map((x) => Math.min(0, x));
  const dd = Math.sqrt(down.reduce((s, x) => s + x * x, 0) / down.length);
  return (mean(r) / dd) * Math.sqrt(TRADING_DAYS);
}

/** Largest peak-to-trough decline of a price/equity series (negative fraction). */
export function maxDrawdown(px) {
  let peak = px[0];
  let peakIdx = 0;
  let mdd = 0;
  let from = 0;
  let to = 0;
  px.forEach((p, i) => {
    if (p > peak) { peak = p; peakIdx = i; }
    const dd = p / peak - 1;
    if (dd < mdd) { mdd = dd; from = peakIdx; to = i; }
  });
  return { mdd, from, to };
}

export function cov(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}
export const corr = (a, b) => cov(a, b) / (std(a) * std(b));
export const beta = (asset, market) => cov(asset, market) / cov(market, market);
export function autocorr(r, lag = 1) {
  return corr(r.slice(lag), r.slice(0, r.length - lag));
}

/**
 * EWMA volatility (RiskMetrics, λ = 0.94). sigma[t] uses returns up to and including t,
 * so it is the forecast for day t + 1. Seeded with the sample variance of the first `warm` returns.
 */
export function ewmaVol(r, lambda = 0.94, warm = 20) {
  const out = new Array(r.length);
  let v = std(r.slice(0, warm)) ** 2 || r[0] ** 2 || 1e-4;
  for (let t = 0; t < r.length; t++) {
    v = lambda * v + (1 - lambda) * r[t] * r[t];
    out[t] = Math.sqrt(v);
  }
  return out;
}

/** Simple moving average; null until n values exist. */
export function sma(x, n) {
  const out = new Array(x.length).fill(null);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** Wilder RSI; null until warm. */
export function rsi(px, n = 14) {
  const out = new Array(px.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < px.length; i++) {
    const d = px[i] - px[i - 1];
    const up = Math.max(d, 0);
    const dn = Math.max(-d, 0);
    if (i <= n) {
      g += up / n; l += dn / n;
      if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

/** Wilder average true range on OHLC bars; null until warm. */
export function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i <= n) { a += tr / n; if (i === n) out[i] = a; } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function logFact(n) {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
/** Exact two-sided binomial test p-value: P(outcome as or less likely than k | n, p). */
export function binomTestP(k, n, p = 0.5) {
  if (n === 0) return 1;
  const lf = [0];
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  const pmf = (i) => Math.exp(lf[n] - lf[i] - lf[n - i] + i * Math.log(p) + (n - i) * Math.log(1 - p));
  const pk = pmf(k);
  let tot = 0;
  for (let i = 0; i <= n; i++) { const pi = pmf(i); if (pi <= pk * (1 + 1e-9)) tot += pi; }
  return Math.min(1, tot);
}
export { logFact };

/** t-statistic of the mean (H0: mean = 0). */
export const tStat = (r) => mean(r) / (std(r) / Math.sqrt(r.length));

/** Summary card for one price series. */
export function describe(bars, marketBars = null) {
  const px = bars.map((b) => b.c);
  const r = simpleReturns(px);
  const last = px[px.length - 1];
  const yr = Math.min(TRADING_DAYS, px.length - 1);
  const out = {
    last,
    change1d: px[px.length - 1] / px[px.length - 2] - 1,
    return1m: last / px[px.length - 1 - Math.min(21, px.length - 1)] - 1,
    return1y: last / px[px.length - 1 - yr] - 1,
    cagr: cagr(px),
    vol: annVol(r),
    volNow: ewmaVol(logReturns(px)).at(-1) * Math.sqrt(TRADING_DAYS),
    sharpe: sharpe(r),
    sortino: sortino(r),
    maxDrawdown: maxDrawdown(px).mdd,
    autocorr1: autocorr(r, 1),
    rsi14: rsi(px).at(-1),
    days: px.length,
  };
  if (marketBars) {
    const m = alignReturns([bars, marketBars]);
    out.beta = beta(m[0], m[1]);
    out.corrMarket = corr(m[0], m[1]);
  }
  return out;
}

/** Align several bar series on common timestamps → array of simple-return arrays. */
export function alignReturns(seriesList) {
  const common = seriesList.map((s) => new Map(s.map((b) => [b.t, b.c])));
  const ts = [...common[0].keys()].filter((t) => common.every((m) => m.has(t))).sort((a, b) => a - b);
  return common.map((m) => simpleReturns(ts.map((t) => m.get(t))));
}
