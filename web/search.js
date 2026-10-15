// Watchlist search by name ("Tesla" → TSLA) with a short company card before adding.
import { $, esc, nf, debounce } from "./ui.js";
import { describe } from "../engine/stats.js";
import { classify } from "../engine/classify.js";

const pct = (x, d = 1) => `${x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;

export function createSearch(ctx) {
  const input = $("#sym-search");
  const list = $("#sym-results");
  const card = $("#sym-card");
  let items = [];
  let active = -1;
  let seq = 0;

  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const renderList = () => {
    list.innerHTML = items.length ? items.map((r, i) => `<li role="option" id="sr-${i}" aria-selected="${i === active}" data-i="${i}"><b class="mono">${esc(r.symbol)}</b> <span>${esc(r.name)}</span><span class="sub"> · ${esc(r.typeLabel || r.type || "")} ${esc(r.exchange || "")}</span></li>`).join("")
      : `<li class="sub" aria-disabled="true">No matches</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", active >= 0 ? `sr-${active}` : "");
  };
  const run = debounce(async () => {
    const q = input.value.trim();
    if (!q) return close();
    const my = ++seq;
    try {
      const r = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
      if (my !== seq) return;
      items = r.results ?? [];
      active = items.length ? 0 : -1;
      renderList();
    } catch { if (my === seq) { items = []; renderList(); } }
  }, 220);

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); renderList(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); renderList(); e.preventDefault(); }
    else if (e.key === "Enter") { if (items[active]) pick(items[active]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("[data-i]"); if (li) { e.preventDefault(); pick(items[Number(li.dataset.i)]); } });
  input.addEventListener("blur", () => setTimeout(close, 120));

  async function pick(r) {
    close();
    input.value = "";
    card.hidden = false;
    card.innerHTML = `<div class="sub">Loading ${esc(r.symbol)}…</div>`;
    const cls = classify(r.symbol, r);
    let stats = null;
    let err = null;
    try {
      const d = ctx.state.data.get(r.symbol) ?? await ctx.fetchHistory(r.symbol);
      if (d.bars.length >= 30) stats = describe(d.bars, ctx.state.data.get("SPY")?.bars);
      ctx.state.meta[r.symbol] = { ...(ctx.state.meta[r.symbol] ?? {}), type: r.type, sector: r.sector, name: r.name };
    } catch (e) { err = e.message; }
    const inList = ctx.state.watchlist.includes(r.symbol);
    card.innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline"><b class="mono" style="font-size:16px">${esc(r.symbol)}</b><button class="btn small" data-x aria-label="Close">×</button></div>
      <div>${esc(r.name)}</div>
      <div class="sub">${esc(r.typeLabel || r.type || "")} · ${esc(r.exchange || "")}</div>
      <div class="sub">${esc(r.sector ? `${r.sector}${r.industry ? ` · ${r.industry}` : ""}` : cls.assetClass !== "Unclassified" ? `${cls.assetClass} · ${cls.sector}` : "Sector not available")}</div>
      ${stats ? `<table class="mini"><tr><td>Last</td><td class="num">${nf(stats.last, 2)}</td></tr><tr><td>1 year</td><td class="num ${stats.return1y >= 0 ? "up" : "down"}">${pct(stats.return1y)}</td></tr>
        <tr><td>Volatility</td><td class="num">${(stats.vol * 100).toFixed(0)}%</td></tr><tr><td>Worst drop</td><td class="num down">${(stats.maxDrawdown * 100).toFixed(0)}%</td></tr>
        ${stats.beta != null ? `<tr><td>Beta vs S&amp;P</td><td class="num">${stats.beta.toFixed(2)}</td></tr>` : ""}</table>` : `<p class="sub">${esc(err ?? "Not enough price history for statistics.")}</p>`}
      <div class="row" style="margin-top:8px">${inList ? `<span class="sub">Already in your watchlist</span>` : `<button class="btn small primary" data-add ${stats ? "" : "disabled"}>Add to watchlist</button>`}
      <button class="btn small" data-open ${stats && stats.days >= 300 ? "" : "disabled"}>Open in Ticker lab</button></div>`;
    card.querySelector("[data-x]").addEventListener("click", () => { card.hidden = true; });
    card.querySelector("[data-add]")?.addEventListener("click", async () => { await ctx.addSymbol(r.symbol); pick(r); });
    card.querySelector("[data-open]")?.addEventListener("click", async () => { if (!ctx.state.watchlist.includes(r.symbol)) await ctx.addSymbol(r.symbol); ctx.selectTicker(r.symbol); });
  }
  return { pick };
}
