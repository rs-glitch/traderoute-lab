// Homepage: (1) the user's portfolio graphed over time vs the S&P 500, (2) live market trends:
// major indexes, VIX, 10-year yield, and today's sector moves.

import { $, $$, esc, nf, hover } from "./ui.js";
import { priceChart, sparkline } from "./charts.js";

const pct = (x, d = 1) => `${x > 0 ? "▲ +" : x < 0 ? "▼ " : ""}${(x * 100).toFixed(d)}%`;
// Yields move in basis points (0.01 percentage points); a % change of a % level reads wrongly.
const bp = (d) => `${d >= 0 ? "▲ +" : "▼ "}${Math.round(d * 100)} bp`;
const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const usd = (x) => `${x < 0 ? "−" : ""}$${nf(Math.abs(x), Math.abs(x) < 100 ? 2 : 0)}`;
const RANGES = [["1M", 21], ["3M", 63], ["6M", 126], ["1Y", 252], ["5Y", 1300]];

export function createHome(ctx) {
  let range = 252;
  let market = null;
  let timer = null;

  /** Value of the CURRENT holdings on each past date (shares held constant) + cash. */
  function portfolioSeries() {
    const held = Object.entries(ctx.state.holdings).filter(([s, q]) => q > 0 && ctx.state.data.has(s));
    const spy = ctx.state.data.get("SPY")?.bars;
    if (!held.length || !spy) return null;
    const maps = held.map(([s, q]) => ({ q, m: new Map(ctx.state.data.get(s).bars.map((b) => [b.t, b.c])), first: ctx.state.data.get(s).bars[0].t }));
    const start = Math.max(...maps.map((x) => x.first));
    const dates = spy.map((b) => b.t).filter((t) => t >= start);
    const last = maps.map(() => null);
    const pts = [];
    for (const t of dates) {
      let v = ctx.state.cash;
      maps.forEach((x, i) => { const c = x.m.get(t); if (c != null) last[i] = c; v += x.q * (last[i] ?? 0); });
      pts.push({ t, c: v });
    }
    return { pts, spy: spy.filter((b) => b.t >= start), heldCount: held.length };
  }

  function renderPortfolio() {
    const el = $("#home-portfolio");
    const s = portfolioSeries();
    if (!s) {
      el.innerHTML = `<h2>Your portfolio</h2><div class="empty"><p>Import a broker CSV or enter shares in <b>Current holdings</b> to see your portfolio's value over time, next to the S&amp;P 500.</p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-open-import>Import from Schwab, Fidelity or Robinhood</button><button class="btn" data-sample="schwab-positions">Try a sample portfolio</button></div></div>`;
      el.querySelector("[data-open-import]").addEventListener("click", () => ctx.openImport());
      el.querySelector("[data-sample]").addEventListener("click", (e) => ctx.importSample(e.target.dataset.sample));
      return;
    }
    const pts = s.pts.slice(-range);
    const spy = s.spy.slice(-range);
    const scale = pts[0].c / spy[0].c;
    const now = Object.entries(ctx.state.holdings).reduce((a, [sym, q]) => a + (ctx.state.data.has(sym) ? q * ctx.lastPrice(sym) : 0), ctx.state.cash);
    const prev = Object.entries(ctx.state.holdings).reduce((a, [sym, q]) => a + (ctx.state.data.has(sym) ? q * ctx.prevClose(sym) : 0), ctx.state.cash);
    const rRet = pts.at(-1).c / pts[0].c - 1;
    const sRet = spy.at(-1).c / spy[0].c - 1;
    el.innerHTML = `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Your portfolio</h2>
      <div class="seg" id="pf-range">${RANGES.map(([l, n]) => `<button data-r="${n}" aria-pressed="${n === range}">${l}</button>`).join("")}</div></div>
      <div class="tiles" style="margin:12px 0">
        <div class="tile"><div class="k">Value now</div><div class="v">${usd(now)}</div><div class="d">${s.heldCount} positions + ${usd(ctx.state.cash)} cash</div></div>
        <div class="tile"><div class="k">Today</div><div class="v ${cls(now - prev)}">${usd(now - prev)}</div><div class="d ${cls(now - prev)}">${pct(now / prev - 1, 2)}</div></div>
        <div class="tile"><div class="k">Over ${RANGES.find(([, n]) => n === range)[0]}</div><div class="v ${cls(rRet)}">${pct(rRet)}</div><div class="d">S&amp;P 500 (SPY): ${pct(sRet)}</div></div>
      </div>
      <div id="pf-chart"></div>
      <div class="legend-row"><span><i style="background:var(--accent)"></i>Your current holdings</span><span><i style="background:var(--ink-2)"></i>S&amp;P 500 (SPY), scaled to the same start</span></div>
      <p class="sub">Shows how <b>today's holdings</b> would have moved over this period, held constant. It isn't your actual trade history, and it leaves out dividends received as cash.</p>`;
    priceChart($("#pf-chart"), pts, [{ name: "S&P 500 (scaled)", values: spy.map((b) => b.c * scale), color: "var(--ink-2)", dash: "5 4" }], { height: 240 });
    for (const b of $$("#pf-range button")) b.addEventListener("click", () => { range = Number(b.dataset.r); renderPortfolio(); });
  }

  async function loadMarket() {
    try {
      market = await (await fetch("/api/market")).json();
      renderMarket();
    } catch {
      $("#home-market").innerHTML = `<h2>Market today</h2><p class="sub">Couldn't load market data.</p>`;
    }
  }

  function renderMarket() {
    const m = market;
    if (!m) return;
    const SESSION = { open: ["● Market open", "live"], "pre-market": ["◐ Pre-market", "snap"], "after-hours": ["◑ After hours", "snap"], closed: ["○ Market closed", "snap"], unknown: ["Market status unknown", "snap"] };
    const [sLabel, sCls] = SESSION[m.session] ?? SESSION.unknown;
    const offline = m.indexes.some((x) => x.source === "snapshot" || x.source === "stale-cache");
    const card = (x) => {
      if (x.error) return `<div class="idx"><div class="k">${esc(x.label)}</div><div class="sub">unavailable</div></div>`;
      const isYield = x.symbol === "^TNX";
      const isVix = x.symbol === "^VIX";
      const val = isYield ? `${x.last.toFixed(2)}%` : nf(x.last, x.last < 100 ? 2 : 0);
      const hint = isVix ? `<div class="sub">${x.last < 20 ? "below 20: calm" : x.last < 30 ? "20–30: nervous" : "above 30: fearful"} (rule of thumb)</div>` : isYield ? `<div class="sub">${x.change1d >= 0 ? "higher" : "lower"} yields today</div>` : "";
      return `<div class="idx" data-sym="${esc(x.symbol)}"><div class="k">${esc(x.label)}</div><div class="v">${val}</div>
        <div class="${isVix || isYield ? "" : cls(x.change1d)} mono">${isYield ? bp(x.last - x.prev) : pct(x.change1d, 2)} <span class="sub">today</span></div>
        <div class="sub mono">${isYield ? bp(x.last - x.last / (1 + x.change1m)) : pct(x.change1m, 1)} 1M</div>${sparkline(x.spark, { width: 120, height: 26 })}${hint}</div>`;
    };
    const sectors = [...m.sectors].filter((x) => !x.error).sort((a, b) => b.change1d - a.change1d);
    const maxAbs = Math.max(0.005, ...sectors.map((x) => Math.abs(x.change1d)));
    $("#home-market").innerHTML = `<div class="row" style="justify-content:space-between"><h2 style="margin:0">Market today</h2>
      <span class="row"><span class="badge ${sCls}">${sLabel}</span><span class="sub">${offline ? "some data from snapshot · " : ""}updated ${new Date(m.at).toLocaleTimeString()}</span></span></div>
      <div class="idx-grid">${m.indexes.map(card).join("")}</div>
      <h3>Sectors today <span class="sub">(sector ETFs, sorted)</span></h3>
      <div class="sectors">${sectors.map((x) => `<div class="sec" data-tip="${esc(x.label)}|${x.change1d}|${x.change1m}"><span class="lbl">${esc(x.label)}</span>
        <span class="bar-wrap"><span class="bar ${x.change1d >= 0 ? "pos" : "neg"}" style="width:${(Math.abs(x.change1d) / maxAbs) * 50}%;${x.change1d >= 0 ? "left:50%" : `right:50%`}"></span><span class="mid"></span></span>
        <span class="mono ${cls(x.change1d)}">${pct(x.change1d, 2)}</span></div>`).join("")}</div>`;
    for (const el of $$("#home-market .sec")) {
      const [label, d1, m1] = el.dataset.tip.split("|");
      hover(el, `<b>${esc(label)}</b><br>today ${pct(Number(d1), 2)}<br>1 month ${pct(Number(m1), 1)}`);
    }
  }

  return {
    render() { renderPortfolio(); if (!market) loadMarket(); else renderMarket(); },
    renderPortfolio,
    start() { clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === "visible" && ctx.state.tab === "market") loadMarket(); }, 60000); },
  };
}
