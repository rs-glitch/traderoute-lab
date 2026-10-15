// TradeRoute Lab web app. The server only supplies market data; the engine runs here, so every
// preference change re-plans instantly and every number matches the API, MCP server and tests.

import * as E from "../engine/index.js";
import { sma } from "../engine/stats.js";
import { $, $$, esc, nf, debounce } from "./ui.js";
import { priceChart, fanChart, heatmap, sparkline, allocationBars, routeDiagram } from "./charts.js";
import { methodsHtml } from "./methods.js";
import { createTour } from "./tour.js";
import { createHome } from "./home.js";
import { createSearch } from "./search.js";
import { createImporter } from "./importer.js";
import { createExposureView } from "./exposure-view.js";
import { createChat } from "./chat.js";

const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const sgn = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : `${x > 0 ? "▲ +" : x < 0 ? "▼ " : ""}${(x * 100).toFixed(d)}%`);
const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const usd = (x) => `$${nf(x, Math.abs(x) < 100 ? 2 : 0)}`;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DEFAULT_WATCH = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "JPM", "XOM", "TLT", "GLD"];
const state = {
  tab: "market",
  prefs: { ...E.DEFAULT_PREFS, ...store.get("trl.prefs", {}) },
  cash: store.get("trl.cash", 100000),
  watchlist: store.get("trl.watch", DEFAULT_WATCH),
  holdings: store.get("trl.holdings", {}),
  data: new Map(),
  selected: "NVDA",
  range: 252,
  analysis: new Map(),
  plan: null,
  quotes: new Map(),
  paper: store.get("trl.paper", null),
  meta: {},
};
const save = () => { store.set("trl.prefs", state.prefs); store.set("trl.cash", state.cash); store.set("trl.watch", state.watchlist); store.set("trl.holdings", state.holdings); };

// ---------- data ----------
async function loadSymbol(sym) {
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}`);
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  if (d.bars.length < 300) throw new Error(`${sym}: only ${d.bars.length} days of history (need 300)`);
  state.data.set(sym, d);
  return d;
}
const prevClose = (sym) => { const q = state.quotes.get(sym); if (q?.prevClose) return q.prevClose; const d = state.data.get(sym); return d ? (d.intraday ? d.bars.at(-1).c : d.bars.at(-2)?.c ?? d.bars.at(-1).c) : 0; };
const lastPrice = (sym) => state.quotes.get(sym)?.last ?? state.data.get(sym)?.intraday?.c ?? state.data.get(sym)?.bars.at(-1).c;
const series = () => state.watchlist.filter((s) => state.data.has(s)).map((s) => ({ symbol: s, bars: state.data.get(s).bars }));

function renderBadge() {
  const all = [...state.data.values()];
  if (!all.length) return;
  const live = all.filter((d) => d.source === "live" || d.source === "cache").length;
  const asOf = new Date(Math.max(...all.map((d) => d.bars.at(-1).t))).toISOString().slice(0, 10);
  const intraday = all.some((d) => d.intraday);
  const b = $("#data-badge");
  b.className = `badge ${live === all.length ? "live" : "snap"}`;
  b.textContent = live === all.length ? `LIVE · daily close ${asOf}${intraday ? " + intraday" : ""}` : `SNAPSHOT ${asOf} · ${all.length - live}/${all.length} offline`;
  b.title = all.map((d) => `${d.symbol}: ${d.source}${d.liveError ? ` (${d.liveError})` : ""}`).join("\n");
}

// ---------- tabs ----------
function showTab(tab) {
  state.tab = tab;
  for (const b of $$("nav.tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const s of $$("main section")) s.hidden = s.dataset.view !== tab;
  if (tab === "market") home?.render();
  if (tab === "exposure") exposureView?.render();
  if (tab === "ticker") renderTicker();
  if (tab === "plan") renderPlan();
  if (tab === "paper") renderPaper();
  if (tab === "methods" && !$("#methods").innerHTML) $("#methods").innerHTML = methodsHtml();
  if (location.hash !== "#demo") history.replaceState(null, "", `#${tab}`);
}
for (const b of $$("nav.tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ---------- preferences rail ----------
function renderRail() {
  const p = state.prefs;
  $("#f-cash").value = state.cash;
  $("#cash-v").textContent = usd(state.cash);
  $("#f-risk").value = p.risk;
  $("#risk-v").textContent = `${p.risk} · ${E.RISK_PROFILES[p.risk - 1].label} (${pct(E.RISK_PROFILES[p.risk - 1].targetVol, 0)} vol)`;
  for (const b of $$("#f-horizon button")) b.setAttribute("aria-pressed", String(Number(b.dataset.h) === p.horizonDays));
  $("#f-style").value = p.style;
  $("#f-cap").value = p.maxPositionPct;
  $("#cap-v").textContent = pct(p.maxPositionPct, 0);
  $("#f-long").checked = p.longOnly;
  $("#watchlist").innerHTML = state.watchlist.map((s) => `<span class="chip ${s === state.selected ? "sel" : ""}"><a href="#ticker" data-sel="${s}" style="color:inherit;text-decoration:none">${s}</a><button data-rm="${s}" aria-label="Remove ${s}">×</button></span>`).join("");
  $("#holdings").innerHTML = `<tbody>${state.watchlist.map((s) => `<tr><td class="mono">${s}</td><td><input type="number" min="0" step="any" data-h="${s}" value="${state.holdings[s] ?? 0}" aria-label="${s} shares"></td><td class="num sub">${state.data.has(s) ? usd((state.holdings[s] ?? 0) * lastPrice(s)) : ""}</td></tr>`).join("")}</tbody>`;
}
const replan = debounce(() => {
  save();
  state.plan = null;
  state.analysis.clear();
  renderRail();
  if (state.tab === "plan") renderPlan();
  if (state.tab === "ticker") renderTicker();
}, 120);
export function setPrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  replan();
}
$("#f-cash").addEventListener("change", (e) => { state.cash = Math.max(0, Number(e.target.value) || 0); replan(); });
$("#f-risk").addEventListener("input", (e) => setPrefs({ risk: Number(e.target.value) }));
for (const b of $$("#f-horizon button")) b.addEventListener("click", () => setPrefs({ horizonDays: Number(b.dataset.h) }));
$("#f-style").addEventListener("change", (e) => setPrefs({ style: e.target.value }));
$("#f-cap").addEventListener("input", (e) => setPrefs({ maxPositionPct: Number(e.target.value) }));
$("#f-long").addEventListener("change", (e) => setPrefs({ longOnly: e.target.checked }));
$("#watchlist").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]")?.dataset.rm;
  const sel = e.target.closest("[data-sel]")?.dataset.sel;
  if (rm) {
    if (state.watchlist.length <= 2) { $("#add-msg").textContent = "Keep at least two tickers."; return; }
    state.watchlist = state.watchlist.filter((s) => s !== rm);
    delete state.holdings[rm];
    if (state.selected === rm) state.selected = state.watchlist[0];
    replan(); renderMarket();
  }
  if (sel) { e.preventDefault(); selectTicker(sel); }
});
async function addSymbol(sym) {
  if (state.watchlist.includes(sym)) return;
  $("#add-msg").textContent = `Fetching ${sym}…`;
  try {
    if (!state.data.has(sym)) await loadSymbol(sym);
    state.watchlist.push(sym);
    $("#add-msg").textContent = `${sym} added (${state.data.get(sym).source}).`;
    replan(); renderMarket(); renderBadge();
  } catch (err) { $("#add-msg").textContent = err.message; }
}
$("#holdings").addEventListener("change", (e) => {
  const s = e.target.dataset.h;
  if (!s) return;
  const q = Math.max(0, Math.round((Number(e.target.value) || 0) * 1e6) / 1e6); // fractional shares allowed
  if (q) state.holdings[s] = q; else delete state.holdings[s];
  replan();
});

// ---------- market ----------
function renderMarket() {
  const spy = state.data.get("SPY")?.bars;
  const rows = state.watchlist.filter((s) => state.data.has(s)).map((s) => {
    const d = state.data.get(s);
    const st = E.describe(d.bars, spy && s !== "SPY" ? spy : null);
    return { s, d, st };
  });
  $("#market-table").innerHTML = `<table><thead><tr><th>Ticker</th><th class="num">Last</th><th class="num">1 day</th><th class="num">1 year</th><th class="num">Volatility</th><th class="num" title="Risk-free rate 0; daily returns annualized with √252">Sharpe (5y, rf 0)</th><th class="num">Worst drop</th><th class="num">Beta</th><th>1 year</th></tr></thead><tbody>${rows.map(({ s, d, st }) => `
    <tr class="click" data-sel="${s}"><td><b class="mono">${s}</b> <span class="sub">${esc((d.name || "").slice(0, 22))}</span></td>
    <td class="num">${nf(lastPrice(s), 2)}</td><td class="num ${cls(st.change1d)}">${sgn(st.change1d, 2)}</td><td class="num ${cls(st.return1y)}">${sgn(st.return1y)}</td>
    <td class="num">${pct(st.vol, 0)}</td><td class="num">${st.sharpe.toFixed(2)}</td><td class="num down">${pct(st.maxDrawdown, 0)}</td><td class="num">${st.beta == null ? "1.00" : st.beta.toFixed(2)}</td>
    <td>${sparkline(d.bars.slice(-252).map((b) => b.c))}</td></tr>`).join("")}</tbody></table>`;
  for (const tr of $$("#market-table tr[data-sel]")) tr.addEventListener("click", () => selectTicker(tr.dataset.sel));
  const plan = getPlan();
  if (plan) heatmap($("#corr"), plan.plan.symbols, plan.plan.correlation);
}

// ---------- ticker ----------
export function selectTicker(sym) {
  state.selected = sym;
  renderRail();
  showTab("ticker");
}
function getAnalysis(sym) {
  const key = `${sym}|${state.prefs.horizonDays}|${state.prefs.longOnly}`;
  if (!state.analysis.has(key)) {
    const spy = state.data.get("SPY")?.bars;
    state.analysis.set(key, E.analyzeTicker(state.data.get(sym).bars, { marketBars: sym !== "SPY" ? spy : null, horizon: state.prefs.horizonDays, longOnly: state.prefs.longOnly }));
  }
  return state.analysis.get(key);
}
function renderTicker() {
  const sym = state.selected;
  const d = state.data.get(sym);
  if (!d) return;
  const a = getAnalysis(sym);
  const st = a.stats;
  const f = a.forecast;
  const c = a.calibration;
  $("#p-thead").innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline">
      <div><span class="brand" style="font-size:22px">${sym}</span> <span class="sub">${esc(d.name || "")} · ${esc(d.exchange || "")}</span></div>
      <div class="row"><span class="mono" style="font-size:22px">${nf(lastPrice(sym), 2)}</span><span class="mono ${cls(st.change1d)}">${sgn(st.change1d, 2)}</span><span class="badge ${d.source === "live" || d.source === "cache" ? "live" : "snap"}">${d.source}${d.intraday ? " · intraday bar excluded" : ""}</span></div></div>
    <div class="tiles" id="p-tstats" style="margin-top:12px">
      <div class="tile"><div class="k">1-year return</div><div class="v ${cls(st.return1y)}">${sgn(st.return1y)}</div><div class="d">5y CAGR ${pct(st.cagr)}</div></div>
      <div class="tile"><div class="k">Volatility now</div><div class="v">${pct(st.volNow, 0)}</div><div class="d">5y average ${pct(st.vol, 0)} (EWMA λ 0.94)</div></div>
      <div class="tile"><div class="k">Worst drop (5y)</div><div class="v down">${pct(st.maxDrawdown, 0)}</div><div class="d">Sharpe ${st.sharpe.toFixed(2)} · Sortino ${st.sortino.toFixed(2)}</div></div>
      <div class="tile"><div class="k">vs S&amp;P 500</div><div class="v">β ${st.beta == null ? "1.00" : st.beta.toFixed(2)}</div><div class="d">correlation ${st.corrMarket == null ? "1.00" : st.corrMarket.toFixed(2)}</div></div>
    </div>`;
  const bars = d.bars.slice(-state.range);
  const px = d.bars.map((b) => b.c);
  const off = d.bars.length - bars.length;
  priceChart($("#price-chart"), bars, [
    { name: "50-day avg", values: sma(px, 50).slice(off), color: "var(--warn)" },
    { name: "200-day avg", values: sma(px, 200).slice(off), color: "var(--ink-2)", dash: "5 4" },
  ]);
  $("#fan-title").textContent = `Where ${sym} could be in ${f.horizon} trading days (2,000 simulated paths)`;
  fanChart($("#fan-chart"), d.bars, f);
  const calibOk = Math.abs(c.coverage - c.level) < 0.06;
  $("#fan-tiles").innerHTML = `
    <div class="tile"><div class="k">Chance it's higher</div><div class="v">${pct(f.probUp, 0)}</div><div class="d">close to a coin flip, as markets usually are</div></div>
    <div class="tile"><div class="k">90% range</div><div class="v" style="font-size:18px"><span class="down">${sgn(f.band90[0], 0)}</span> … <span class="up">${sgn(f.band90[1], 0)}</span></div><div class="d">${nf(f.fan.at(-1).p5, 2)} to ${nf(f.fan.at(-1).p95, 2)}</div></div>
    <div class="tile"><div class="k">Bad-case loss</div><div class="v down">−${pct(f.var95, 1)}</div><div class="d">VaR 95%; average of worst 5%: −${pct(f.cvar95, 1)}</div></div>
    <div class="tile ${calibOk ? "" : "warn"}" id="calib-tile"><div class="k">Is the range honest?</div><div class="v">${pct(c.coverage, 0)}</div><div class="d">of ${c.origins} past forecasts landed inside their 90% band (${pct(c.below, 0)} below, ${pct(c.above, 0)} above)</div></div>`;
  const sig = a.signals;
  const evidence = sig.filter((s) => s.verdict.level === "evidence").length;
  $("#signals").innerHTML = `<table><thead><tr><th>Signal</th><th class="num">Says now</th><th class="num">CAGR</th><th class="num">Buy &amp; hold</th><th class="num">Sharpe</th><th class="num">Right on</th><th class="num">vs base rate</th><th>Verdict</th></tr></thead><tbody>${sig.map((s) => `
    <tr title="${esc(s.about)}"><td>${esc(s.name)}</td><td class="num">${s.current > 0 ? '<span class="up">▲ long</span>' : s.current < 0 ? '<span class="down">▼ short</span>' : "— flat"}${Math.abs(s.current) % 1 ? ` ${Math.abs(s.current).toFixed(2)}` : ""}</td>
    <td class="num">${pct(s.cagr)}</td><td class="num">${pct(s.benchmarkCagr)}</td><td class="num">${s.sharpe.toFixed(2)}</td>
    <td class="num">${pct(s.hitRate, 1)}</td><td class="num">${pct(s.hitBaseRate, 1)} <span class="sub">p=${s.hitP.toFixed(2)}</span></td>
    <td><span class="verdict ${s.verdict.level}">${esc(s.verdict.label)}</span></td></tr>`).join("")}</tbody></table>`;
  const from = new Date(d.bars[sig[0].start].t).toISOString().slice(0, 10);
  const to = new Date(d.bars.at(-1).t).toISOString().slice(0, 10);
  $("#signals-note").innerHTML = `<b>Hypothetical, backtested results.</b> ${evidence} of ${sig.length} signals clear the t &gt; ${E.HURDLE_T} bar on ${sym}. Window ${from} → ${to} (${sig[0].days} days, mostly a rising market), after a 1-day execution lag, ${state.prefs.costBps} bp costs, ${state.prefs.longOnly ? "long-only" : "long/short"}. Each signal is compared with buy &amp; hold scaled to its own average exposure. "Right on" is compared with the share of days a random pick would be right (the base rate), not with 50%. Parameters are fixed from the literature, never fitted here.`;
}
for (const b of $$("#range-seg button")) b.addEventListener("click", () => { state.range = Number(b.dataset.r); for (const x of $$("#range-seg button")) x.setAttribute("aria-pressed", String(x === b)); renderTicker(); });

// ---------- plan & routes ----------
function getPlan() {
  if (state.plan) return state.plan;
  const ser = series();
  if (ser.length < 2) return null;
  const held = Object.entries(state.holdings).reduce((a, [s, q]) => a + (state.data.has(s) ? q * lastPrice(s) : 0), 0);
  state.plan = E.planTrades(ser, { ...state.prefs, capital: state.cash + held }, { holdings: state.holdings, cash: state.cash });
  return state.plan;
}
function renderPlan() {
  const p = getPlan();
  if (!p) return;
  const { plan, routes } = p;
  $("#plan-tiles").innerHTML = `
    <div class="tile"><div class="k">Portfolio value</div><div class="v">${usd(routes.equity)}</div><div class="d">${E.RISK_PROFILES[plan.prefs.risk - 1].label} profile</div></div>
    <div class="tile ${plan.reachesTarget ? "" : "warn"}"><div class="k">Expected volatility</div><div class="v">${pct(plan.expectedVol, 1)}</div><div class="d">target ${pct(plan.targetVol, 0)} per year${plan.riskTiltGamma > 0 ? " · tilted toward higher-vol names" : ""}</div></div>
    <div class="tile"><div class="k">A 1-in-20 bad year</div><div class="v down">−${usd(1.645 * plan.expectedVol * routes.equity)}</div><div class="d">1-in-20 one-year loss if returns were normal (1.645σ)</div></div>
    <div class="tile"><div class="k">Invested / cash</div><div class="v">${pct(plan.gross, 0)} <small>/ ${pct(plan.cash, 0)}</small></div><div class="d">diversification ratio ${plan.diversificationRatio.toFixed(2)}×</div></div>`;
  const tilts = plan.weights.filter((w) => w.evidence > 0).length;
  $("#plan-note").innerHTML = `${!plan.reachesTarget ? `<p class="note">Your ${pct(plan.targetVol, 0)} target isn't reachable ${plan.prefs.longOnly ? "long-only " : ""}without leverage at a ${pct(plan.prefs.maxPositionPct, 0)} position cap. The best available is ${pct(plan.expectedVol, 1)}. Raise the cap, or add higher-volatility tickers.</p>` : ""}
    <p class="sub" style="margin:10px 0 0">${plan.riskTiltGamma > 0 ? `The base portfolio equalizes risk contributions. To reach your volatility target, the risk dial then tilts toward higher-volatility names (γ = ${plan.riskTiltGamma.toFixed(2)}), so the orange risk shares are no longer equal.` : "Built from equal risk contributions, so no single asset dominates the risk."} ${tilts ? `${tilts} position${tilts > 1 ? "s are" : " is"} tilted because the ${esc(E.SIGNALS[E.STYLE_SIGNAL[plan.prefs.style]].name)} signal has evidence there.` : `No tilts: the ${esc(E.SIGNALS[E.STYLE_SIGNAL[plan.prefs.style]].name)} signal has no historical edge on these tickers, so the plan ignores it. That's deliberate.`}</p>`;
  allocationBars($("#alloc"), plan.weights);
  $("#routes-sum").innerHTML = `${plan.prefs.longOnly ? "" : "Shorts allowed: a short appears only when a signal clears the evidence bar (none do right now), and shorts aren't booked in paper trading. "}${routes.orders.length} orders · turnover ${usd(routes.turnover)} · est. costs ${usd(routes.estCosts)} · cash after ${usd(routes.cashAfter)} · each position sized so a stop-out loses at most ${usd(routes.riskBudget)} (${pct(E.RISK_PROFILES[plan.prefs.risk - 1].riskPerTrade, 1)} of the portfolio).`;
  $("#routes").innerHTML = routes.orders.map((o) => `
    <div class="route"><div class="head"><span class="mono sub">#${o.step}</span><span class="side ${o.side}">${o.side}</span><b class="mono">${o.symbol}</b>
      <span class="mono">${nf(o.shares, o.shares % 1 ? 3 : 0)} sh @ ≤ ${nf(o.limit, 2)}</span><span class="sub">${usd(o.notional)}</span>
      ${o.route ? `<span class="sub">· risk ${usd(o.route.riskDollars)} to make ${usd(o.route.rewardDollars)}</span>` : ""}</div>
      ${o.route ? routeDiagram(o) : ""}
      <div class="why">${esc(o.why)}${o.route && o.route.tranches.length > 1 ? ` Staged over ${o.route.tranches.length} tranches: ${o.route.tranches.map((t) => `day ${t.day}: ${t.shares} sh`).join(", ")}.` : ""}</div></div>`).join("") || `<p class="sub">Already at target. Nothing to trade.</p>`;
}
$("#exec-all").addEventListener("click", () => { executeAll(); showTab("paper"); });

// ---------- paper trading ----------
// The paper book and the plan share one source of truth: the book starts from the rail's cash and
// holdings, and after every execution the rail is synced from the book (so re-planning sees the fills).
function paper() {
  if (!state.paper) {
    const positions = {};
    for (const [s, q] of Object.entries(state.holdings)) if (q > 0 && state.data.has(s)) positions[s] = { shares: q, avg: lastPrice(s) };
    state.paper = { cash: state.cash, positions, log: [], equity: [] };
  }
  return state.paper;
}
function syncRailFromPaper() {
  const pp = paper();
  state.holdings = Object.fromEntries(Object.entries(pp.positions).map(([s, p]) => [s, p.shares]));
  state.cash = Math.round(pp.cash * 100) / 100;
  state.plan = null;
  save();
  renderRail();
}
const savePaper = () => store.set("trl.paper", state.paper);
export function executeAll() {
  const p = getPlan();
  const pp = paper();
  const c = state.prefs.costBps / 1e4;
  for (const o of p.routes.orders) {
    const quote = lastPrice(o.symbol);
    const px = quote * (o.side === "buy" || o.side === "cover" ? 1.001 : 0.999);
    const pos = pp.positions[o.symbol] ?? { shares: 0, avg: 0 };
    if (o.side === "buy") {
      // A limit order: fill only if the (slipped) quote is at or below the limit, and never below the stop.
      if (px > o.limit) { pp.log.unshift({ t: Date.now(), side: "SKIP", sym: o.symbol, q: 0, px, note: `not filled: ${px.toFixed(2)} above limit ${o.limit.toFixed(2)}` }); continue; }
      if (o.route && px <= o.route.stop) { pp.log.unshift({ t: Date.now(), side: "SKIP", sym: o.symbol, q: 0, px, note: "not filled: price already through the stop" }); continue; }
      const q = Math.min(o.shares, Math.floor(pp.cash / (px * (1 + c))));
      if (q <= 0) continue;
      pp.cash -= q * px * (1 + c);
      pos.avg = (pos.avg * pos.shares + q * px * (1 + c)) / (pos.shares + q); // cost basis includes fees
      pos.shares += q;
      pos.stop = o.route?.stop; pos.target = o.route?.target;
      pp.log.unshift({ t: Date.now(), side: "BUY", sym: o.symbol, q, px, note: "route order" });
    } else if (o.side === "sell") {
      const q = Math.min(o.shares, pos.shares);
      if (q <= 0) continue;
      pp.cash += q * px * (1 - c);
      pos.shares -= q;
      pp.log.unshift({ t: Date.now(), side: "SELL", sym: o.symbol, q, px, pnl: q * (px * (1 - c) - pos.avg), note: "route order" });
    } else { pp.log.unshift({ t: Date.now(), side: "SKIP", sym: o.symbol, q: 0, px, note: `${o.side} orders aren't simulated in the paper book (long-only)` }); continue; }
    if (pos.shares > 0) pp.positions[o.symbol] = pos; else delete pp.positions[o.symbol];
  }
  pp.startValue ??= state.cash + Object.entries(state.holdings).reduce((a, [s, q]) => a + q * lastPrice(s), 0);
  markToMarket();
  syncRailFromPaper();
}
function markToMarket() {
  const pp = paper();
  const c = state.prefs.costBps / 1e4;
  let changed = false;
  for (const [s, pos] of Object.entries(pp.positions)) {
    const px = lastPrice(s);
    const hit = pos.stop != null && px <= pos.stop ? "stop" : pos.target != null && px >= pos.target ? "target" : null;
    if (hit) {
      pp.cash += pos.shares * px * (1 - c);
      pp.log.unshift({ t: Date.now(), side: "SELL", sym: s, q: pos.shares, px, pnl: pos.shares * (px * (1 - c) - pos.avg), note: `${hit} hit (filled at quote; gaps can pass the level)` });
      changed = true;
      delete pp.positions[s];
    }
  }
  const value = pp.cash + Object.entries(pp.positions).reduce((a, [s, pos]) => a + pos.shares * lastPrice(s), 0);
  pp.equity.push({ t: Date.now(), v: value });
  pp.equity = pp.equity.slice(-500);
  savePaper();
  if (changed) syncRailFromPaper();
  if (state.tab === "paper") renderPaper();
}
async function refreshQuotes() {
  const syms = [...new Set([...state.watchlist, ...Object.keys(paper().positions)])];
  try {
    const r = await (await fetch(`/api/quotes?symbols=${syms.join(",")}`)).json();
    for (const q of r.quotes) if (!q.error) state.quotes.set(q.symbol, q);
    $("#quote-at").textContent = `quotes ${new Date(r.at).toLocaleTimeString()}`;
  } catch { $("#quote-at").textContent = "quote refresh failed; showing last known prices"; }
  markToMarket();
}
function renderPaper() {
  const pp = paper();
  const rows = Object.entries(pp.positions).map(([s, pos]) => {
    const px = lastPrice(s);
    return { s, pos, px, value: pos.shares * px, pnl: pos.shares * (px - pos.avg) };
  });
  const value = pp.cash + rows.reduce((a, r) => a + r.value, 0);
  const start = pp.startValue ?? value;
  const srcs = new Set(Object.keys(pp.positions).map((s) => state.quotes.get(s)?.source ?? state.data.get(s)?.source));
  const realized = pp.log.reduce((a, l) => a + (l.pnl ?? 0), 0);
  $("#paper-tiles").innerHTML = `
    <div class="tile"><div class="k">Account value</div><div class="v">${usd(value)}</div><div class="d ${cls(value - start)}">${sgn(value / start - 1, 2)} since first trade</div></div>
    <div class="tile"><div class="k">Cash</div><div class="v">${usd(pp.cash)}</div><div class="d">${rows.length} open positions · prices: ${[...srcs].join(", ") || "—"}</div></div>
    <div class="tile"><div class="k">Unrealized P&amp;L</div><div class="v ${cls(rows.reduce((a, r) => a + r.pnl, 0))}">${usd(rows.reduce((a, r) => a + r.pnl, 0))}</div><div class="d">realized ${usd(realized)}</div></div>`;
  $("#paper-pos").innerHTML = rows.length ? `<thead><tr><th>Ticker</th><th class="num">Shares</th><th class="num">Avg cost</th><th class="num">Last</th><th class="num">Value</th><th class="num">P&amp;L</th><th class="num">Stop</th><th class="num">Target</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${r.s}</td><td class="num">${nf(r.pos.shares)}</td><td class="num">${nf(r.pos.avg, 2)}</td><td class="num">${nf(r.px, 2)}</td><td class="num">${usd(r.value)}</td><td class="num ${cls(r.pnl)}">${usd(r.pnl)}</td><td class="num down">${r.pos.stop ? nf(r.pos.stop, 2) : "—"}</td><td class="num up">${r.pos.target ? nf(r.pos.target, 2) : "—"}</td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="sub">No positions yet. Build a plan, then "Execute all on paper".</td></tr></tbody>`;
  $("#paper-log").innerHTML = pp.log.length ? `<thead><tr><th>Time</th><th>Side</th><th>Ticker</th><th class="num">Shares</th><th class="num">Price</th><th class="num">P&amp;L</th><th>Note</th></tr></thead><tbody>${pp.log.slice(0, 50).map((l) => `<tr><td class="sub">${new Date(l.t).toLocaleString()}</td><td><span class="side ${l.side.toLowerCase()}">${l.side}</span></td><td class="mono">${l.sym}</td><td class="num">${nf(l.q)}</td><td class="num">${nf(l.px, 2)}</td><td class="num ${cls(l.pnl ?? 0)}">${l.pnl == null ? "" : usd(l.pnl)}</td><td class="sub">${esc(l.note)}</td></tr>`).join("")}</tbody>` : `<tbody><tr><td class="sub">No activity.</td></tr></tbody>`;
}
$("#refresh").addEventListener("click", refreshQuotes);
$("#reset").addEventListener("click", () => { state.paper = null; store.set("trl.paper", null); renderPaper(); });
setInterval(() => { if (document.visibilityState === "visible" && state.tab === "paper") refreshQuotes(); }, 60000);

// ---------- theme ----------
$("#theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = cur === "light" ? "dark" : "light";
  if (state.tab === "ticker") renderTicker();
});

// ---------- portfolio features: home, search, import, exposure, chat ----------
async function ensureMeta(symbols) {
  await Promise.all(symbols.filter((s) => !state.meta[s]).map(async (s) => {
    try { state.meta[s] = await (await fetch(`/api/profile?symbol=${encodeURIComponent(s)}`)).json(); } catch { state.meta[s] = {}; }
    if (!state.meta[s].type && state.data.get(s)?.type) state.meta[s].type = state.data.get(s).type;
  }));
}
async function applyImport(parsed, useCash) {
  const syms = parsed.positions.map((p) => p.symbol);
  const results = await Promise.allSettled(syms.filter((s) => !state.data.has(s)).map(loadSymbol));
  const failed = syms.filter((s) => !state.data.has(s));
  for (const s of syms) if (state.data.has(s) && !state.watchlist.includes(s)) state.watchlist.push(s);
  state.holdings = Object.fromEntries(parsed.positions.filter((p) => p.shares > 0).map((p) => [p.symbol, p.shares]));
  if (useCash && parsed.cash) state.cash = Math.max(0, parsed.cash);
  state.paper = null;
  store.set("trl.paper", null);
  state.plan = null;
  save();
  renderRail(); renderBadge(); renderMarket();
  if (state.tab === "market") home.render();
  if (state.tab === "exposure") exposureView.render();
  void results;
  return { failed };
}
const ctx = { state, lastPrice, prevClose, selectTicker, addSymbol, ensureMeta, applyImport, fetchHistory: loadSymbol, openImport: () => importer.open(), importSample: (n) => importer.sample(n), ask: (q) => chat.ask(q) };
const home = createHome(ctx);
const importer = createImporter(ctx);
const exposureView = createExposureView(ctx);
const chat = createChat(ctx);
createSearch(ctx);
$("#import-btn").addEventListener("click", () => importer.open());

// ---------- demo ----------
const tour = createTour({ state, showTab, selectTicker, setPrefs, executeAll, getAnalysis, getPlan, E, importSample: (n) => importer.sample(n), ask: (q) => chat.ask(q), ensureMeta });
$("#demo-btn").addEventListener("click", () => tour.start());
window.addEventListener("hashchange", () => { if (location.hash === "#demo" && state.data.size) tour.start(); });

// ---------- boot ----------
(async function boot() {
  renderRail();
  const results = await Promise.allSettled(state.watchlist.map(loadSymbol));
  const failed = state.watchlist.filter((_, i) => results[i].status === "rejected");
  if (failed.length) { state.watchlist = state.watchlist.filter((s) => !failed.includes(s)); $("#add-msg").textContent = `Couldn't load: ${failed.join(", ")}`; }
  if (!state.watchlist.includes(state.selected)) state.selected = state.watchlist[0];
  renderBadge();
  renderRail();
  renderMarket();
  home.start();
  const h = location.hash.slice(1);
  if (h === "demo") { showTab("market"); tour.start(); }
  else if (["market", "exposure", "ticker", "plan", "paper", "methods"].includes(h)) showTab(h);
  else showTab("market");
})();
