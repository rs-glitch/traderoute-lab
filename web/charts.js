// Hand-rolled SVG charts: price + moving averages with crosshair, forecast fan, correlation
// heatmap, sparkline, allocation bars, route bracket. Thin marks, one y-axis, hover everywhere.

import { svgEl, hover, esc, nf } from "./ui.js";

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const day = (t) => new Date(t).toISOString().slice(0, 10);
function ticks(lo, hi, n = 5) {
  const step0 = (hi - lo) / n || 1;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/** Price chart with optional overlay lines and a crosshair tooltip. */
export function priceChart(el, bars, overlays = [], { width = 760, height = 280 } = {}) {
  const m = { t: 12, r: 56, b: 24, l: 8 };
  const xs = (i) => m.l + (i / Math.max(1, bars.length - 1)) * (width - m.l - m.r);
  const vals = bars.map((b) => b.c).concat(overlays.flatMap((o) => o.values.filter((v) => v != null)));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const ys = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (height - m.t - m.b);
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Price chart" });
  for (const v of ticks(lo, hi)) {
    svg.append(svgEl("line", { class: "grid", x1: m.l, x2: width - m.r, y1: ys(v), y2: ys(v) }));
    const t = svgEl("text", { x: width - m.r + 6, y: ys(v) + 4 }); t.textContent = nf(v, v < 10 ? 2 : 0); svg.append(t);
  }
  const path = (vals2, attrs) => {
    let d = "";
    vals2.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`; });
    svg.append(svgEl("path", { d, fill: "none", "stroke-width": 2, ...attrs }));
  };
  path(bars.map((b) => b.c), { stroke: "var(--accent)" });
  for (const o of overlays) path(o.values, { stroke: o.color, "stroke-width": 1.5, "stroke-dasharray": o.dash ?? "" });
  [0, Math.floor(bars.length / 2), bars.length - 1].forEach((i, k) => {
    const t = svgEl("text", { x: xs(i), y: height - 6, "text-anchor": k === 0 ? "start" : k === 2 ? "end" : "middle" }); t.textContent = day(bars[i].t); svg.append(t);
  });
  const cross = svgEl("line", { x1: 0, x2: 0, y1: m.t, y2: height - m.b, stroke: "var(--ink-2)", "stroke-dasharray": "3 3", visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  const hit = svgEl("rect", { class: "hit", x: m.l, y: m.t, width: width - m.l - m.r, height: height - m.t - m.b });
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(bars.length - 1, Math.round(((x - m.l) / (width - m.l - m.r)) * (bars.length - 1))));
    cross.setAttribute("x1", xs(i)); cross.setAttribute("x2", xs(i)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", xs(i)); dot.setAttribute("cy", ys(bars[i].c)); dot.setAttribute("visibility", "visible");
    const tip = document.getElementById("tip");
    tip.innerHTML = `<b>${day(bars[i].t)}</b><br>close ${nf(bars[i].c, 2)}${overlays.map((o) => (o.values[i] != null ? `<br>${esc(o.name)} ${nf(o.values[i], 2)}` : "")).join("")}`;
    tip.hidden = false; tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 14}px`;
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); document.getElementById("tip").hidden = true; });
  svg.append(hit);
  el.replaceChildren(svg);
}

/** Recent history + forecast fan (5–95 and 25–75 bands, median, faint sample paths). */
export function fanChart(el, bars, fc, { width = 760, height = 280, history = 90, showPaths = true } = {}) {
  const m = { t: 12, r: 56, b: 24, l: 8 };
  const hist = bars.slice(-history).map((b) => b.c);
  const n = hist.length + fc.fan.length;
  const xs = (i) => m.l + (i / (n - 1)) * (width - m.l - m.r);
  const shown = showPaths ? fc.samplePaths.slice(0, 20) : [];
  const all = hist.concat(fc.fan.flatMap((f) => [f.p5, f.p95]), shown.flat());
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const ys = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (height - m.t - m.b);
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Forecast fan: 90% band ${nf(fc.fan.at(-1).p5, 2)} to ${nf(fc.fan.at(-1).p95, 2)}` });
  for (const v of ticks(lo, hi)) {
    svg.append(svgEl("line", { class: "grid", x1: m.l, x2: width - m.r, y1: ys(v), y2: ys(v) }));
    const t = svgEl("text", { x: width - m.r + 6, y: ys(v) + 4 }); t.textContent = nf(v, v < 10 ? 2 : 0); svg.append(t);
  }
  const h0 = hist.length - 1;
  const band = (a, b, fill) => {
    const top = fc.fan.map((f, i) => `${xs(h0 + 1 + i)},${ys(f[b])}`);
    const bot = fc.fan.map((f, i) => `${xs(h0 + 1 + i)},${ys(f[a])}`).reverse();
    svg.append(svgEl("polygon", { points: [`${xs(h0)},${ys(hist[h0])}`, ...top, ...bot].join(" "), fill }));
  };
  band("p5", "p95", "var(--band-outer)");
  band("p25", "p75", "var(--band-inner)");
  for (const p of shown) {
    svg.append(svgEl("polyline", { points: [`${xs(h0)},${ys(hist[h0])}`, ...p.map((v, i) => `${xs(h0 + 1 + i)},${ys(v)}`)].join(" "), fill: "none", stroke: "var(--ink-2)", "stroke-width": 0.6, opacity: 0.25 }));
  }
  svg.append(svgEl("polyline", { points: hist.map((v, i) => `${xs(i)},${ys(v)}`).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 2 }));
  svg.append(svgEl("polyline", { points: [`${xs(h0)},${ys(hist[h0])}`, ...fc.fan.map((f, i) => `${xs(h0 + 1 + i)},${ys(f.p50)}`)].join(" "), fill: "none", stroke: "var(--ink)", "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
  svg.append(svgEl("line", { x1: xs(h0), x2: xs(h0), y1: m.t, y2: height - m.b, stroke: "var(--axis)" }));
  const lab = (x, y, text, anchor = "start") => { const t = svgEl("text", { x, y, "text-anchor": anchor, class: "lbl" }); t.textContent = text; svg.append(t); };
  lab(xs(h0) - 4, height - 6, "today", "end");
  lab(xs(n - 1), height - 6, `+${fc.horizon}d`, "end");
  const f = fc.fan.at(-1);
  for (const [k, name] of [["p95", "95th"], ["p50", "median"], ["p5", "5th"]]) lab(xs(n - 1) + 4, ys(f[k]) + 4, `${name}`);
  const hit = svgEl("rect", { class: "hit", x: xs(h0), y: m.t, width: xs(n - 1) - xs(h0), height: height - m.t - m.b });
  hover(hit, () => `<b>In ${fc.horizon} trading days</b><br>90% band: ${nf(f.p5, 2)} – ${nf(f.p95, 2)}<br>50% band: ${nf(f.p25, 2)} – ${nf(f.p75, 2)}<br>median ${nf(f.p50, 2)} · P(up) ${pct(fc.probUp, 0)}`);
  svg.append(hit);
  el.replaceChildren(svg);
}

/** Correlation heatmap (diverging: red −1 … gray 0 … blue +1). */
export function heatmap(el, symbols, C) {
  const cell = 34;
  const lab = 52;
  const w = lab + cell * symbols.length;
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${w} ${w}`, role: "img", "aria-label": "Correlation matrix" });
  const color = (c) => {
    const a = Math.min(1, Math.abs(c));
    return c >= 0 ? `color-mix(in srgb, var(--div-pos) ${Math.round(a * 100)}%, var(--div-mid))` : `color-mix(in srgb, var(--div-neg) ${Math.round(a * 100)}%, var(--div-mid))`;
  };
  symbols.forEach((s, i) => {
    const t1 = svgEl("text", { x: lab - 6, y: lab + i * cell + cell / 2 + 4, "text-anchor": "end", class: "lbl" }); t1.textContent = s; svg.append(t1);
    const t2 = svgEl("text", { x: lab + i * cell + cell / 2, y: lab - 8, "text-anchor": "middle", class: "lbl" }); t2.textContent = s.slice(0, 4); svg.append(t2);
    symbols.forEach((s2, j) => {
      const r = svgEl("rect", { x: lab + j * cell + 1, y: lab + i * cell + 1, width: cell - 2, height: cell - 2, rx: 3, style: `fill:${color(C[i][j])}` });
      hover(r, `<b>${s} × ${s2}</b><br>correlation ${C[i][j].toFixed(2)}`);
      svg.append(r);
    });
  });
  el.replaceChildren(svg);
}

export function sparkline(values, { width = 90, height = 24 } = {}) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)}`).join(" ");
  const up = values.at(-1) >= values[0];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(${up ? "--up" : "--down"})" stroke-width="1.5"/></svg>`;
}

/** Allocation bars: weight (bar) with risk contribution (tick). */
export function allocationBars(el, weights, { width = 760 } = {}) {
  const rowH = 26;
  const lab = 64;
  const m = { r: 110 };
  const height = weights.length * rowH + 22;
  const max = Math.max(0.05, ...weights.map((w) => Math.max(Math.abs(w.weight), w.riskContribution)));
  const x = (v) => lab + (v / max) * (width - lab - m.r);
  const svg = svgEl("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Target allocation" });
  weights.forEach((w, i) => {
    const y = i * rowH;
    const t = svgEl("text", { x: lab - 8, y: y + 17, "text-anchor": "end", class: "lbl" }); t.textContent = w.symbol; svg.append(t);
    svg.append(svgEl("rect", { x: lab, y: y + 6, width: Math.max(1, x(Math.abs(w.weight)) - lab), height: 14, rx: 3, style: `fill: var(${w.weight >= 0 ? "--accent" : "--down"})` }));
    const rc = x(Math.max(0, w.riskContribution));
    svg.append(svgEl("line", { x1: rc, x2: rc, y1: y + 3, y2: y + 23, stroke: "var(--warn)", "stroke-width": 2 }));
    const v = svgEl("text", { x: width - m.r + 8, y: y + 17, class: "lbl" }); v.textContent = `${(w.weight * 100).toFixed(1)}%  $${nf(w.dollars)}`; svg.append(v);
    const hit = svgEl("rect", { class: "hit", x: 0, y, width, height: rowH });
    hover(hit, `<b>${w.symbol}</b> ${(w.weight * 100).toFixed(1)}% · risk share ${(w.riskContribution * 100).toFixed(1)}%<br>${esc(w.rationale)}`);
    svg.append(hit);
  });
  const ly = height - 6;
  svg.append(svgEl("rect", { x: lab, y: ly - 9, width: 10, height: 10, rx: 2, style: "fill:var(--accent)" }));
  const l1 = svgEl("text", { x: lab + 14, y: ly }); l1.textContent = "weight"; svg.append(l1);
  svg.append(svgEl("line", { x1: lab + 80, x2: lab + 80, y1: ly - 10, y2: ly + 1, stroke: "var(--warn)", "stroke-width": 2 }));
  const l2 = svgEl("text", { x: lab + 86, y: ly }); l2.textContent = "share of portfolio risk"; svg.append(l2);
  el.replaceChildren(svg);
}

/** Route bracket: stop ← entry → target on a price axis, with first-passage probabilities. */
export function routeDiagram(o, { width = 520, height = 64 } = {}) {
  const r = o.route;
  const lo = Math.min(r.stop, r.target, o.limit);
  const hi = Math.max(r.stop, r.target, o.limit);
  const pad = (hi - lo) * 0.08;
  const x = (v) => 12 + ((v - lo + pad) / (hi - lo + 2 * pad)) * (width - 24);
  const seg = (a, b, color) => `<line x1="${x(a)}" x2="${x(b)}" y1="20" y2="20" stroke="var(${color})" stroke-width="6" stroke-linecap="round"/>`;
  const mark = (v, label, color, anchor) => `<line x1="${x(v)}" x2="${x(v)}" y1="10" y2="30" stroke="var(${color})" stroke-width="2"/><text x="${x(v)}" y="44" text-anchor="${anchor}" class="lbl">${label} ${nf(v, 2)}</text>`;
  const w = width - 24;
  const pt = r.pTarget * w;
  const pn = r.pNeither * w;
  return `<svg class="chart" style="max-width:${width}px" viewBox="0 0 ${width} ${height + 18}" role="img" aria-label="Stop ${nf(r.stop, 2)}, entry ${nf(o.limit, 2)}, target ${nf(r.target, 2)}; P(target first) ${(r.pTarget * 100).toFixed(0)}%">
    ${seg(r.stop, o.limit, "--down")}${seg(o.limit, r.target, "--up")}
    ${mark(r.stop, "stop", "--down-ink", r.stop < o.limit ? "start" : "end")}${mark(o.limit, "entry", "--ink", "middle")}${mark(r.target, "target", "--up-ink", r.target > o.limit ? "end" : "start")}
    <rect x="12" y="${height - 6}" width="${pt}" height="10" rx="2" style="fill:var(--up)"/>
    <rect x="${12 + pt + 2}" y="${height - 6}" width="${Math.max(0, pn - 2)}" height="10" rx="2" style="fill:var(--axis)"/>
    <rect x="${12 + pt + pn + 2}" y="${height - 6}" width="${Math.max(0, w - pt - pn - 2)}" height="10" rx="2" style="fill:var(--down)"/>
    <text x="12" y="${height + 16}" class="lbl">target first ${(r.pTarget * 100).toFixed(0)}% · neither in ${r.horizonDays}d ${(r.pNeither * 100).toFixed(0)}% · stop first ${(r.pStop * 100).toFixed(0)}%</text>
  </svg>`;
}
