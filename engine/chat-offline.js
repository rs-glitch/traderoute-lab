// Portfolio chat pieces that need no server: input validation, tools bound to the user's portfolio,
// and the offline answerer (rule-based answers from the same tools, clearly labeled "offline").
// Used by server/chat.js and by the static demo build. Injected: tools (engine/tools.js), getHistory.

const TICKER = /^[A-Z0-9.\-^=]{1,12}$/;
/** Validate what the browser sends: tickers, finite non-negative shares and cash, bounded sizes. */
export function sanitizePortfolio(p = {}) {
  const holdings = {};
  for (const [k, v] of Object.entries(p.holdings ?? {}).slice(0, 200)) {
    const sym = String(k).toUpperCase();
    const q = Number(v);
    if (TICKER.test(sym) && Number.isFinite(q) && q >= 0) holdings[sym] = q;
  }
  const cash = Number(p.cash);
  const watchlist = (Array.isArray(p.watchlist) ? p.watchlist : []).map((s) => String(s).toUpperCase()).filter((s) => TICKER.test(s)).slice(0, 60);
  return { holdings, cash: Number.isFinite(cash) && cash >= 0 ? cash : 0, watchlist };
}

export const preview = (x) => { const s = JSON.stringify(x); return s.length > 600 ? `${s.slice(0, 600)}…` : s; };

/** Tools bound to the user's portfolio: the model never has to (or gets to) invent holdings. */
export function bound(tools, portfolio) {
  const holdings = portfolio?.holdings ?? {};
  const cash = Number(portfolio?.cash ?? 0);
  return {
    get_prices: (a) => tools.get_prices(a),
    analyze_ticker: (a) => tools.analyze_ticker(a),
    backtest_signal: (a) => tools.backtest_signal(a),
    search_symbols: (a) => tools.search_symbols(a),
    get_portfolio_exposure: () => tools.get_portfolio_exposure({ holdings, cash }),
    position_risk: (a) => tools.position_risk({ ...a, holdings, cash }),
  };
}

// ---------- offline mode: rule-based answers from the same tools ----------
const pct = (x, d = 0) => `${(x * 100).toFixed(d).replace(/^-(0\.?0*)$/, "$1")}%`; // tiny negatives round to "0%", not "-0%"

/** Signal sentence built from the graded results, never assumed. */
export function signalLine(sym, signals) {
  const strong = signals.filter((s) => /^Edge over/.test(s.verdict));
  const worse = signals.filter((s) => /^Reliably worse/.test(s.verdict));
  if (strong.length) return `• ${strong.map((s) => s.name).join(", ")} ${strong.length > 1 ? "show" : "shows"} an edge on ${sym} that clears the t > 3 bar. That's a hypothetical backtest, not a promise.`;
  if (worse.length) return `• ${worse.map((s) => s.name).join(", ")} did reliably worse than buy & hold on ${sym} (hypothetical backtest).`;
  return `• None of the ${signals.length} trading signals shows a reliable edge on ${sym}, so there's no evidence-based "timing" call here.`;
}
/** Describe P(up) honestly: only call it a coin flip when it is one. */
export function probUpPhrase(p) {
  if (Math.abs(p - 0.5) < 0.07) return `${pct(p)} (close to a coin flip)`;
  return `${pct(p)} (${p > 0.5 ? "somewhat above" : "somewhat below"} even odds under this model)`;
}
const usd = (x) => `$${Math.round(x).toLocaleString("en-US")}`;

async function findSymbol(text, portfolio, getHistory) {
  const known = [...new Set([...Object.keys(portfolio.holdings ?? {}), ...(portfolio.watchlist ?? [])])];
  const upper = text.match(/\b[A-Z]{1,5}\b/g) ?? [];
  const hit = upper.find((t) => known.includes(t));
  if (hit) return hit;
  const lower = text.toLowerCase();
  for (const s of known) {
    try { const d = await getHistory(s); const first = (d.name || "").toLowerCase().split(/[\s,.]+/)[0]; if (first.length > 2 && lower.includes(first)) return s; } catch { /* ignore */ }
  }
  const STOP = new Set(["I", "A", "IS", "MY", "AM", "IN", "ON", "OF", "IF", "OK", "TO", "UP", "ETF", "ETFS", "USD", "US", "CEO", "AI", "IPO", "EPS", "PE", "GDP", "FED", "CPI", "YTD", "ATH", "NYSE", "SEC", "IRA", "API", "DO", "OR", "AND", "THE", "WHAT", "HOW", "WHY", "NOW"]);
  return upper.find((t) => t.length >= 2 && !STOP.has(t)) ?? null;
}

/** Rule-based answerer over the same tools. `notice` tells the reader how to get Claude answers in this deployment. */
export function makeOfflineAnswer({ tools, getHistory, notice = "Offline mode: rule-based answers from the same tools. Set ANTHROPIC_API_KEY on the server for Claude." }) {
  return (question, portfolio) => offlineAnswer(question, portfolio, { tools, getHistory, notice });
}

async function offlineAnswer(question, portfolio, { tools, getHistory, notice }) {
  const impl = bound(tools, portfolio);
  const trace = [];
  const call = async (name, input) => { const out = await impl[name](input); trace.push({ name, input, result: preview(out) }); return out; };
  const q = question.toLowerCase();
  const sym = await findSymbol(question, portfolio, getHistory);
  const held = Object.values(portfolio.holdings ?? {}).some((x) => x > 0);
  const base = { mode: "offline", toolCalls: trace, notice };
  const drop = q.match(/(?:drops?|falls?|crash(?:es)?|down)\s*(?:by\s*)?(\d{1,2})\s*%/);

  try {
    if (sym && /(worr|risk|safe|concern|exposed|lose|loss|scared|nervous|position|drop|fall|crash)/.test(q)) {
      const r = await call("position_risk", { symbol: sym });
      const lines = [r.held ? `I can't tell you whether to worry, but here's what the numbers show for your ${sym} position:` : `You don't hold ${sym}, but here's its risk picture:`];
      if (r.held) lines.push(`• It's ${pct(r.weight)} of your portfolio (${usd(r.value)}) and accounts for ${pct(r.riskShare)} of the portfolio's recent volatility (its share of variance).`);
      lines.push(`• Volatility is ${pct(r.volNow)} a year now vs a ${pct(r.volAvg5y)} five-year average${r.volElevated ? ", noticeably elevated" : ""}.`);
      lines.push(`• Over the next ${r.forecast.horizonDays} trading days, simulated odds of a loss worse than 10%: ${pct(r.forecast.probLossOver10pct)}. The 90% range is ${pct(r.forecast.band90[0])} to +${pct(r.forecast.band90[1])}.`);
      if (r.held) lines.push(`• A ${drop ? drop[1] : 20}% drop would cost about ${usd(r.value * (drop ? drop[1] / 100 : 0.2))} (${pct((r.value * (drop ? drop[1] / 100 : 0.2)) / r.portfolioTotal, 1)} of the portfolio). Repeating its worst 5-year drawdown (${pct(r.maxDrawdown5y)}) would cost about ${usd(r.dollars.ifRepeatsWorstDrawdown)}.`);
      lines.push(signalLine(sym, r.signals));
      if (r.source && r.source !== "live" && r.source !== "cache") lines.push(`(Prices are from the ${r.source}, not live.)`);
      lines.push("Not investment advice.");
      return { ...base, reply: lines.join("\n") };
    }
    if (/(diversif|concentrat|exposure|allocation|sector|breakdown|balanced|spread)/.test(q) || (!sym && /(portfolio|holdings)/.test(q))) {
      if (!held) return { ...base, reply: "You don't have any holdings yet. Import a broker CSV or enter shares in the side panel, then ask again." };
      const e = await call("get_portfolio_exposure", {});
      const cls = e.byAssetClass.map((c) => `${c.name} ${pct(c.weight)} of value / ${pct(c.riskShare)} of risk`).join("; ");
      const lines = [`Here's how your ${usd(e.total)} portfolio is spread:`, `• By asset class: ${cls}.`, `• Largest position: ${e.positions[0].symbol} at ${pct(e.concentration.top1)}; top 3 together ${pct(e.concentration.top3)}. By dollar weights alone it's as concentrated as ${e.concentration.effectiveN.toFixed(1)} equal-sized positions.`, `• Estimated volatility: ${pct(e.annualVol, 1)} a year.`];
      for (const f of e.flags.filter((f) => f.level === "warn")) lines.push(`• ${f.text}`);
      lines.push("Not investment advice.");
      return { ...base, reply: lines.join("\n") };
    }
    if (sym && /(signal|momentum|trend|backtest|timing|technical)/.test(q)) {
      const a = await call("analyze_ticker", { symbol: sym });
      return { ...base, reply: `Signals on ${sym} (hypothetical backtests, ${a.signals[0].days} days, costs included):\n${a.signals.map((s) => `• ${s.name}: ${s.verdict.label}`).join("\n")}\nNot investment advice.` };
    }
    if (sym && /(forecast|predict|outlook|next|future|go up|go down|expect|chance|odds|probab|price)/.test(q)) {
      const a = await call("analyze_ticker", { symbol: sym });
      const f = a.forecast;
      return { ...base, reply: `Nobody can predict ${sym}'s price, but here's the range the model gives for the next ${f.horizon} trading days:\n• Chance it ends higher: ${probUpPhrase(f.probUp)}.\n• 90% range: ${pct(f.band90[0])} to +${pct(f.band90[1])}.\n• In the worst 5% of outcomes, the average loss is ${pct(f.cvar95, 1)}.\n• Past 90% ranges from this model contained ${pct(a.calibration.coverage)} of actual outcomes.\nNot investment advice.` };
    }
    if (/(find|ticker|symbol|what is the ticker|search)/.test(q)) {
      const name = question.replace(/.*(?:for|of|find|search)\s+/i, "").replace(/[?.!]/g, "").trim();
      const s = await call("search_symbols", { query: name });
      if (!s.results.length) return { ...base, reply: `I couldn't find a match for "${name}".` };
      return { ...base, reply: `Matches for "${name}":\n${s.results.slice(0, 5).map((r) => `• ${r.symbol}: ${r.name} (${r.typeLabel || r.type || "?"}, ${r.exchange || "?"})`).join("\n")}` };
    }
  } catch (err) {
    return { ...base, reply: `I couldn't get the numbers for that: ${err.message}` };
  }
  return { ...base, reply: `In offline mode I can answer questions like:\n• "Should I be worried about my NVDA position?"\n• "How diversified is my portfolio?"\n• "What's the outlook range for AAPL next month?"\n• "Do any trading signals work on MSFT?"\n• "Find the ticker for Tesla"` };
}
