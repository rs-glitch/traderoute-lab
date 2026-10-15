// "My portfolio" tab: where the money is vs where the risk is, by asset class, sector and position.
import { $, esc, nf, svgEl, hover } from "./ui.js";
import { exposure } from "../engine/exposure.js";

const pct = (x, d = 0) => `${(x * 100).toFixed(d).replace(/^-(0\.?0*)$/, "$1")}%`; // tiny negatives round to "0%", not "-0%"
const usd = (x) => `$${nf(x, 0)}`;

/** Paired bars: share of value (solid) vs share of risk (orange outline). */
function pairedBars(el, groups, { width = 520 } = {}) {
  const rowH = 30;
  const lab = 150;
  const height = groups.length * rowH + 26;
  const max = Math.max(0.05, ...groups.flatMap((g) => [g.weight, g.riskShare]));
  const x = (v) => lab + (v / max) * (width - lab - 90);
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Share of value vs share of risk" });
  groups.forEach((g, i) => {
    const y = i * rowH;
    const t = svgEl("text", { x: lab - 8, y: y + 19, "text-anchor": "end", class: "lbl" }); t.textContent = g.name.length > 24 ? `${g.name.slice(0, 23)}…` : g.name; svg.append(t);
    svg.append(svgEl("rect", { x: lab, y: y + 5, width: Math.max(1, x(g.weight) - lab), height: 9, rx: 2, style: "fill:var(--accent)" }));
    svg.append(svgEl("rect", { x: lab, y: y + 16, width: Math.max(1, x(g.riskShare) - lab), height: 9, rx: 2, style: "fill:var(--warn)" }));
    const v = svgEl("text", { x: width - 84, y: y + 19, class: "lbl" }); v.textContent = `${pct(g.weight)} · ${pct(g.riskShare)}`; svg.append(v);
    const hit = svgEl("rect", { class: "hit", x: 0, y, width, height: rowH });
    hover(hit, `<b>${esc(g.name)}</b><br>${pct(g.weight, 1)} of value (${usd(g.value)})<br>${pct(g.riskShare, 1)} of day-to-day risk${g.symbols?.length ? `<br>${g.symbols.join(", ")}` : ""}`);
    svg.append(hit);
  });
  const ly = height - 6;
  svg.append(svgEl("rect", { x: lab, y: ly - 9, width: 10, height: 10, rx: 2, style: "fill:var(--accent)" }));
  const a = svgEl("text", { x: lab + 14, y: ly }); a.textContent = "share of value"; svg.append(a);
  svg.append(svgEl("rect", { x: lab + 120, y: ly - 9, width: 10, height: 10, rx: 2, style: "fill:var(--warn)" }));
  const b = svgEl("text", { x: lab + 134, y: ly }); b.textContent = "share of risk"; svg.append(b);
  el.replaceChildren(svg);
}

export function createExposureView(ctx) {
  async function render() {
    const root = $("#exposure");
    const positions = Object.entries(ctx.state.holdings).filter(([, q]) => q !== 0).map(([symbol, shares]) => ({ symbol, shares }));
    if (!positions.length) {
      root.innerHTML = `<div class="panel"><h2>My portfolio</h2><div class="empty"><p>No holdings yet. Import a broker CSV or enter shares in <b>Current holdings</b>.</p><button class="btn primary" data-open-import>Import holdings</button></div></div>`;
      root.querySelector("[data-open-import]").addEventListener("click", () => ctx.openImport());
      return;
    }
    await ctx.ensureMeta(positions.map((p) => p.symbol));
    const data = {};
    for (const p of positions) if (ctx.state.data.has(p.symbol)) data[p.symbol] = { ...ctx.state.data.get(p.symbol), ...(ctx.state.meta[p.symbol] ?? {}) };
    let e;
    try { e = exposure(positions, ctx.state.cash, data); } catch (err) { root.innerHTML = `<div class="panel"><p>${esc(err.message)}</p></div>`; return; }
    const equityish = e.byAssetClass.filter((c) => /equity/i.test(c.name)).reduce((a, c) => a + c.weight, 0);
    root.innerHTML = `
      <div class="panel" id="p-exposure-head"><h2>My portfolio: where the money is vs. where the risk is</h2>
        <div class="tiles">
          <div class="tile"><div class="k">Total value</div><div class="v">${usd(e.total)}</div><div class="d">${e.positions.length} positions · ${pct(e.cash / e.total)} cash</div></div>
          <div class="tile"><div class="k">Stocks / bonds / gold</div><div class="v" style="font-size:19px">${pct(equityish)} / ${pct(e.byAssetClass.find((c) => c.name === "Bonds")?.weight ?? 0)} / ${pct(e.byAssetClass.find((c) => c.name === "Gold & commodities")?.weight ?? 0)}</div><div class="d">share of total value</div></div>
          <div class="tile"><div class="k">Concentration</div><div class="v">${e.concentration.effectiveN.toFixed(1)}</div><div class="d">as concentrated as ${e.concentration.effectiveN.toFixed(1)} equal positions (by dollars) · top holding ${pct(e.concentration.top1)} · top 3 ${pct(e.concentration.top3)}</div></div>
          <div class="tile"><div class="k">Volatility</div><div class="v">${pct(e.annualVol, 1)}</div><div class="d">a year, recent-weighted (EWMA)</div></div>
        </div>
        ${e.flags.length ? `<ul class="flags">${e.flags.map((f) => `<li class="${f.level}"><span aria-hidden="true">${f.level === "warn" ? "⚠" : "ℹ"}</span> ${esc(f.text)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="two" style="margin-top:16px">
        <div class="panel"><h2>By asset class</h2><div id="exp-class"></div></div>
        <div class="panel"><h2>By sector</h2><div id="exp-sector"></div><p class="sub">Broad ETFs (like SPY or VOO) appear as their own category. They aren't split into their underlying holdings.</p></div>
      </div>
      <div class="panel" style="margin-top:16px"><h2>Positions</h2><div class="table-wrap"><table><thead><tr><th>Ticker</th><th>Asset class</th><th>Sector</th><th class="num">Value</th><th class="num">Share of value</th><th class="num">Share of risk</th><th class="num">Volatility</th><th></th></tr></thead>
        <tbody>${e.positions.map((p) => `<tr><td class="mono"><b>${esc(p.symbol)}</b></td><td>${esc(p.assetClass)}</td><td class="sub">${esc(p.sector)}</td><td class="num">${usd(p.value)}</td><td class="num">${pct(p.weight, 1)}</td>
          <td class="num ${p.riskShare > p.weight * 1.5 && p.riskShare > 0.15 ? "down" : ""}">${pct(p.riskShare, 1)}</td><td class="num">${p.vol ? pct(p.vol) : "—"}</td>
          <td><button class="btn small" data-ask="${esc(p.symbol)}">Ask about it</button></td></tr>`).join("")}</tbody></table></div>
        <p class="sub">${esc(e.method)}</p></div>`;
    pairedBars($("#exp-class"), e.byAssetClass);
    pairedBars($("#exp-sector"), e.bySector);
    for (const b of root.querySelectorAll("[data-ask]")) b.addEventListener("click", () => ctx.ask(`Should I be worried about my ${b.dataset.ask} position?`));
  }
  return { render };
}
