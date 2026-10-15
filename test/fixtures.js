import { readFileSync } from "node:fs";
import { mulberry32 } from "../engine/rng.js";

export const snap = (s) => JSON.parse(readFileSync(new URL(`../data/snapshot/${s}.json`, import.meta.url))).data;
export const series = (syms) => syms.map((s) => ({ symbol: s, bars: snap(s).bars }));

/** Synthetic GBM bars with known drift/vol (for known-answer tests). */
export function gbmBars(n = 800, { mu = 0, sigma = 0.01, seed = 1, start = 100 } = {}) {
  const r = mulberry32(seed);
  let p = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
    const np = p * Math.exp(mu + sigma * z);
    out.push({ t: 1.6e12 + i * 864e5, o: p, h: Math.max(p, np) * 1.002, l: Math.min(p, np) * 0.998, c: np, v: 1e6 });
    p = np;
  }
  return out;
}
