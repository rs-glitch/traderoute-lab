import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importHoldings, parseCsv, num } from "../engine/holdings-import.js";
import { classify } from "../engine/classify.js";
import { exposure } from "../engine/exposure.js";
import { positionRisk } from "../engine/position-risk.js";
import { parseSearch } from "../server/search.js";
import { snap } from "./fixtures.js";

const sample = (f) => readFileSync(new URL(`../web/samples/${f}.csv`, import.meta.url), "utf8");
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("CSV basics: quotes, escaped quotes, CRLF, BOM; money parsing", () => {
  assert.deepEqual(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,2,3'), [["a", "b,c", 'say "hi"'], ["1", "2", "3"]]);
  assert.equal(num("$1,234.50"), 1234.5);
  assert.equal(num("(12.30)"), -12.3);
  assert.equal(num("$-150.00"), -150);
  assert.equal(num("-$2.73"), -2.73);
  assert.equal(num("+$84.00"), 84);
  assert.equal(num("--"), null);
});

test("Schwab positions: equities + ETFs, cash captured, options and totals skipped", () => {
  const r = importHoldings(sample("schwab-positions"));
  assert.equal(r.broker, "Schwab");
  assert.deepEqual(r.positions.map((p) => [p.symbol, p.shares]), [["AAPL", 45], ["MSFT", 20], ["NVDA", 120], ["TLT", 60], ["VOO", 30]]);
  assert.equal(r.cash, 8450.25);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ["option contract (not supported)", "total row"]);
});

test("Fidelity positions: accounts merged, money market + pending activity counted as cash", () => {
  const r = importHoldings(sample("fidelity-positions"));
  assert.equal(r.broker, "Fidelity");
  assert.equal(r.positions.find((p) => p.symbol === "GOOGL").shares, 50); // 40 + 10 across two accounts
  assert.equal(r.positions.find((p) => p.symbol === "GOOGL").costBasis, 9400);
  close(r.cash, 5210.44 - 150, 1e-9);
});

test("Robinhood activity: positions rebuilt from buys/sells, fractional shares kept, warning shown", () => {
  const r = importHoldings(sample("robinhood-activity"));
  assert.match(r.broker, /Robinhood/);
  assert.deepEqual(r.positions.map((p) => [p.symbol, p.shares]), [["AMZN", 15], ["SPY", 8.5], ["TSLA", 6], ["XOM", 20]]);
  assert.ok(r.warnings.some((w) => /rebuilt from buys and sells/.test(w)));
});

test("generic CSV works; unusable files fail with a helpful message", () => {
  const r = importHoldings("Ticker,Shares\nmsft,3\nGLD,2\n");
  assert.equal(r.broker, "Generic CSV");
  assert.deepEqual(r.positions.map((p) => p.symbol), ["GLD", "MSFT"]);
  assert.throws(() => importHoldings("a,b\n1,2"), /symbol column and a quantity column/);
  assert.throws(() => importHoldings("Symbol,Quantity\nCash & Cash Investments,100"), /No stock or ETF positions/);
});

test("classification: known funds, provider sectors, name keywords, honest fallback", () => {
  assert.equal(classify("TLT").assetClass, "Bonds");
  assert.equal(classify("GLD").assetClass, "Gold & commodities");
  assert.equal(classify("NVDA").sector, "Technology");
  assert.deepEqual(classify("TSLA", { type: "EQUITY", sector: "Consumer Cyclical" }).sector, "Consumer Cyclical");
  assert.equal(classify("ZZZB", { type: "ETF", name: "Some Short-Term Treasury Bond ETF" }).assetClass, "Bonds");
  assert.equal(classify("QQQZ").assetClass, "Unclassified");
});

const data = () => Object.fromEntries(["NVDA", "AAPL", "TLT", "GLD", "SPY"].map((s) => [s, snap(s)]));

test("exposure: weights + cash = 100%, risk shares sum to 100%, concentration math", () => {
  const pos = [{ symbol: "NVDA", shares: 100 }, { symbol: "AAPL", shares: 30 }, { symbol: "TLT", shares: 100 }, { symbol: "GLD", shares: 10 }];
  const e = exposure(pos, 5000, data());
  const wsum = e.positions.reduce((a, p) => a + p.weight, 0) + e.cash / e.total;
  close(wsum, 1, 1e-3);
  close(e.positions.reduce((a, p) => a + p.riskShare, 0), 1, 1e-3);
  close(e.byAssetClass.reduce((a, c) => a + c.weight, 0), 1, 2e-3);
  const w = e.positions.map((p) => p.value / e.invested);
  close(e.concentration.hhi, w.reduce((a, x) => a + x * x, 0), 1e-4);
  assert.ok(e.annualVol > 0.05 && e.annualVol < 0.6);
  assert.ok(e.flags.some((f) => /NVDA/.test(f.text)), "NVDA concentration should be flagged");
});

test("exposure: equal-risk toy case and missing data are handled", () => {
  const e = exposure([{ symbol: "SPY", shares: 10 }, { symbol: "NOPE", shares: 5 }], 0, data());
  assert.equal(e.positions.length, 1);
  assert.equal(e.positions[0].riskShare, 1);
  assert.deepEqual(e.missing, ["NOPE"]);
  assert.throws(() => exposure([], 0, data()), /empty/);
});

test("position risk: facts only, consistent dollars, no recommendation", () => {
  const pos = [{ symbol: "NVDA", shares: 100 }, { symbol: "TLT", shares: 100 }];
  const r = positionRisk("NVDA", pos, 1000, data());
  assert.equal(r.held, true);
  close(r.dollars.ifDrops20pct, r.value * 0.2, 1e-6);
  close(r.dollars.var95, r.value * r.forecast.var95, 1e-6);
  assert.ok(r.forecast.probLossOver10pct >= 0 && r.forecast.probLossOver10pct <= 1);
  assert.doesNotMatch(JSON.stringify(r).replace(/buy & hold/g, ""), /\b(buy|sell|should)\b/i); // "buy & hold" is a benchmark name, not advice
  assert.throws(() => positionRisk("NOPE", pos, 0, data()), /No price data/);
});

test("search results keep tradable types only", () => {
  const out = parseSearch({ quotes: [
    { symbol: "TSLA", shortname: "Tesla, Inc.", quoteType: "EQUITY", exchDisp: "NASDAQ", sector: "Consumer Cyclical" },
    { symbol: "XTSLA=F", shortname: "Micro Tesla futures", quoteType: "FUTURE" },
    { symbol: "TSLZ", shortname: "2X Inverse Tesla", quoteType: "ETF" },
  ] });
  assert.deepEqual(out.map((r) => r.symbol), ["TSLA", "TSLZ"]);
  assert.equal(out[0].sector, "Consumer Cyclical");
});

// ---- regression tests for the coordinator's portfolio-features audit ----
test("audit #4: fund names match whole words; equity income isn't a bond fund", () => {
  assert.equal(classify("JEPI").assetClass, "US equity");
  assert.equal(classify("ZZGS", { type: "ETF", name: "Goldman Sachs ActiveBeta US Large Cap Equity ETF" }).assetClass, "US equity");
  assert.equal(classify("ZZNL", { type: "ETF", name: "iShares MSCI Netherlands ETF" }).assetClass, "International equity");
  assert.equal(classify("ZZEP", { type: "ETF", name: "Some Equity Premium Income ETF" }).assetClass, "US equity");
  assert.equal(classify("ZZTB", { type: "ETF", name: "Ultra Short Treasury Bond ETF" }).assetClass, "Bonds");
});

test("audit #3: the sector flag only counts stock sectors (no 4775% T-bill bug)", () => {
  const bars = snap("SPY").bars;
  const d = { BIL: { bars: bars.map((b) => ({ ...b, c: 91.5 })) }, SLV: { bars }, AAPL: snap("AAPL") };
  const e = exposure([{ symbol: "BIL", shares: 500 }, { symbol: "SLV", shares: 10 }, { symbol: "AAPL", shares: 5 }], 0, d);
  const sectorFlag = e.flags.find((f) => /stocks and sector funds/.test(f.text));
  if (sectorFlag) assert.match(sectorFlag.text, /Technology stocks and sector funds are 100%/);
  assert.ok(!e.flags.some((f) => /T-bills stocks|Silver stocks/.test(f.text)));
});

test("audit #5: negative Robinhood positions and option rows are reported, not silently used", () => {
  const csv = `"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
"9/1/2026","9/1/2026","9/2/2026","NVDA","NVIDIA","Sell","30","$220.00","$6,600.00"
"9/2/2026","9/2/2026","9/3/2026","AAPL","Apple","Buy","2","$330.00","($660.00)"
"9/3/2026","9/3/2026","9/4/2026","AAPL","AAPL 10/17/2026 Call $350.00","BTO","1","$4.10","($410.00)"`;
  const r = importHoldings(csv);
  assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL"]);
  assert.ok(r.warnings.some((w) => /NVDA: more shares sold than bought/.test(w)));
  assert.ok(r.warnings.some((w) => /1 option trade rows were ignored/.test(w)));
});

test("audit #5: short positions are flagged as excluded in exposure", () => {
  const e = exposure([{ symbol: "SPY", shares: 10 }, { symbol: "NVDA", shares: -5 }], 0, { SPY: snap("SPY"), NVDA: snap("NVDA") });
  assert.ok(e.flags.some((f) => /excluded from these numbers: NVDA \(-5\)/.test(f.text)));
});

test("audit #6: money-market tickers are cash, share classes normalize, new Fidelity header, $ (x) negatives", () => {
  const schwab = `"Symbol","Description","Qty (Quantity)","Price","Mkt Val (Market Value)"
"SWVXX","SCHWAB VALUE ADVANTAGE MONEY INV","5000","$1.00","$5,000.00"
"BRK/B","BERKSHIRE HATHAWAY INC CLASS B","3","$480.00","$1,440.00"
"AAPL","APPLE INC","2","$337.02","$674.04"`;
  const r = importHoldings(schwab);
  assert.equal(r.cash, 5000);
  assert.deepEqual(r.positions.map((p) => p.symbol), ["AAPL", "BRK-B"]);
  const fid2 = `Account,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
"Individual X123",MSFT,MICROSOFT CORP,4,$501.09,$2004.36,$1500.00
"Individual X123",FDRXX,FIDELITY GOVERNMENT CASH RESERVES,,,$1200.00,`;
  const f = importHoldings(fid2);
  assert.equal(f.broker, "Fidelity");
  assert.equal(f.cash, 1200);
  assert.equal(num("$ (1,000.00)"), -1000);
});
