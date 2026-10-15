// Trading signals: causal rules with FIXED, literature-default parameters (no fitting, so no
// in-sample optimization to overfit). pos[t] uses information up to and including close t.
// Output is a desired position in [-1, 1]; long-only callers clamp negatives to 0.

import { sma, rsi } from "./stats.js";

export const SIGNALS = {
  buyhold: {
    name: "Buy & hold", about: "Always 100% long. The benchmark.",
    fn: (px) => px.map(() => 1),
  },
  momentum: {
    name: "Time-series momentum (12-1)",
    about: "Long if the return from 252 to 21 days ago is positive, else short/flat. Time-series momentum (Moskowitz, Ooi & Pedersen 2012); the cross-sectional version is Jegadeesh & Titman (1993).",
    fn: (px) => px.map((_, t) => (t < 252 ? 0 : Math.sign(px[t - 21] / px[t - 252] - 1))),
  },
  trend: {
    name: "Trend (50/200-day average)",
    about: "Long when the 50-day average is above the 200-day, else short/flat.",
    fn: (px) => {
      const f = sma(px, 50);
      const s = sma(px, 200);
      return px.map((_, t) => (s[t] == null ? 0 : f[t] > s[t] ? 1 : -1));
    },
  },
  meanReversion: {
    name: "Mean reversion (RSI 14, 30/70)",
    about: "Long after RSI < 30 until RSI > 50; short after RSI > 70 until RSI < 50.",
    fn: (px) => {
      const r = rsi(px, 14);
      let state = 0;
      return px.map((_, t) => {
        const x = r[t];
        if (x == null) return 0;
        if (state === 0 && x < 30) state = 1;
        else if (state === 0 && x > 70) state = -1;
        else if (state === 1 && x > 50) state = 0;
        else if (state === -1 && x < 50) state = 0;
        return state;
      });
    },
  },
};

/** Balanced composite: average of momentum, trend and mean reversion. */
SIGNALS.balanced = {
  name: "Balanced composite",
  about: "Average of momentum, trend and mean reversion.",
  fn: (px) => {
    const parts = ["momentum", "trend", "meanReversion"].map((k) => SIGNALS[k].fn(px));
    return px.map((_, t) => (parts[0][t] + parts[1][t] + parts[2][t]) / 3);
  },
};

export const STYLE_SIGNAL = { passive: "buyhold", momentum: "momentum", trend: "trend", meanReversion: "meanReversion", balanced: "balanced" };

export function positions(key, px, { longOnly = true } = {}) {
  const s = SIGNALS[key];
  if (!s) throw new Error(`Unknown signal "${key}". Use one of: ${Object.keys(SIGNALS).join(", ")}.`);
  const p = s.fn(px);
  return longOnly ? p.map((x) => Math.max(0, x)) : p;
}
