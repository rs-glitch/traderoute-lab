import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TRL_OFFLINE = "1";              // deterministic: snapshot data, no network
delete process.env.ANTHROPIC_API_KEY;       // exercise the offline answerer
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { chat } = await import("../server/chat.js");

const portfolio = { holdings: { NVDA: 120, AAPL: 45, TLT: 60 }, cash: 8000, watchlist: ["SPY", "NVDA", "AAPL", "TLT", "GLD"] };
const ask = (q) => chat({ messages: [{ role: "user", content: q }], portfolio });
const BANNED = /\b(you should|i recommend|buy more|sell (it|now|your)|will (rise|fall|go))\b/i;

test("'Should I be worried about my NVDA position?' → position facts, honest framing, no advice", async () => {
  const r = await ask("Should I be worried about my NVDA position?");
  assert.equal(r.mode, "offline");
  assert.deepEqual(r.toolCalls.map((t) => t.name), ["position_risk"]);
  assert.match(r.reply, /can't tell you whether to worry/);
  assert.match(r.reply, /of your portfolio/);
  assert.match(r.reply, /Not investment advice/);
  assert.doesNotMatch(r.reply, BANNED);
  assert.match(r.reply, /snapshot/); // data isn't live in this test, and the answer says so
});

test("company names resolve to held tickers; what-if drops use the stated %", async () => {
  const r = await ask("what if nvidia drops 30%?");
  assert.deepEqual(r.toolCalls.map((t) => t.name), ["position_risk"]);
  assert.match(r.reply, /A 30% drop would cost/);
});

test("diversification question → exposure breakdown", async () => {
  const r = await ask("How diversified is my portfolio?");
  assert.deepEqual(r.toolCalls.map((t) => t.name), ["get_portfolio_exposure"]);
  assert.match(r.reply, /By asset class/);
  assert.doesNotMatch(r.reply, BANNED);
});

test("forecast question → ranges and calibration, never a target", async () => {
  const r = await ask("What's the outlook for AAPL next month?");
  assert.match(r.reply, /90% range/);
  assert.match(r.reply, /Nobody can predict/);
  assert.doesNotMatch(r.reply, /target price/i);
});

test("unknown question → help text; bad input rejected", async () => {
  const r = await ask("hello");
  assert.match(r.reply, /I can answer questions like/);
  await assert.rejects(chat({ messages: [] }), /at least one user message/);
});

test("audit #1: signal and odds sentences come from the numbers, not templates", async () => {
  const { signalLine, probUpPhrase } = await import("../server/chat.js");
  assert.match(signalLine("X", [{ name: "Trend", verdict: "Edge over exposure-matched buy & hold (t = 3.40 > 3)" }]), /Trend shows an edge on X/);
  assert.match(signalLine("X", [{ name: "Trend", verdict: "No reliable difference from exposure-matched buy & hold (t = 0.2)" }]), /None of the 1 trading signals/);
  assert.match(probUpPhrase(0.52), /coin flip/);
  assert.doesNotMatch(probUpPhrase(0.64), /coin flip/);
});

test("audit #8: portfolio input is validated before use", async () => {
  const { sanitizePortfolio } = await import("../server/chat.js");
  const p = sanitizePortfolio({ holdings: { nvda: 10, "bad ticker!": 5, AAPL: -3, MSFT: "abc" }, cash: "abc", watchlist: ["spy", "<script>"] });
  assert.deepEqual(p, { holdings: { NVDA: 10 }, cash: 0, watchlist: ["SPY"] });
  const r = await chat({ messages: [{ role: "user", content: "Is the ETF market up?" }], portfolio });
  assert.ok(!r.toolCalls.some((t) => t.input?.symbol === "ETF"), "ETF isn't a ticker");
});
