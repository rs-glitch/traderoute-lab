import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseChart, getHistory } from "../server/data.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("parseChart back-adjusts OHLC and skips null rows", () => {
  const d = parseChart({ chart: { result: [{ meta: { symbol: "X", regularMarketPrice: 11 }, timestamp: [1, 2, 3],
    indicators: { quote: [{ open: [10, null, 11], high: [10, null, 12], low: [9, null, 10], close: [10, null, 11], volume: [5, 0, 6] }], adjclose: [{ adjclose: [5, null, 11] }] } }] } });
  assert.equal(d.bars.length, 2);
  assert.equal(d.bars[0].c, 5);
  assert.equal(d.bars[0].h, 5);
  assert.throws(() => parseChart({ chart: { error: { description: "Not Found" } } }), /Not Found/);
});

test("getHistory falls back to the real snapshot when live fetch fails", async () => {
  const d = await getHistory("SPY", { range: "7y", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(d.source, "snapshot");
  assert.ok(d.bars.length > 1000);
  assert.match(d.liveError, /offline/);
  await assert.rejects(getHistory("bad sym!"), /Invalid symbol/);
});

test("MCP server end to end: tools list and a plan", async () => {
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../server/mcp.js", import.meta.url))] }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["analyze_ticker", "backtest_signal", "get_portfolio_exposure", "get_prices", "plan_trades", "position_risk", "search_symbols"]);
    const r = JSON.parse((await client.callTool({ name: "plan_trades", arguments: { symbols: ["SPY", "TLT"], prefs: { risk: 2 } } })).content[0].text);
    assert.ok(r.routes.orders.length >= 1);
    const bad = await client.callTool({ name: "backtest_signal", arguments: { symbol: "SPY", signal: "astrology" } });
    assert.equal(bad.isError, true);
  } finally { await client.close(); }
});
