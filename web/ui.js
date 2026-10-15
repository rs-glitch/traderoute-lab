// Small DOM helpers shared by the views.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const nf = (n, d = 0) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const usd = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}k`);
export const signed = (n) => (n > 0 ? `+${nf(n)}` : nf(n));
export const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const tipEl = () => document.getElementById("tip");
export const tip = {
  show(evt, html) {
    const t = tipEl();
    t.innerHTML = html;
    t.hidden = false;
    const pad = 14;
    const { innerWidth: W, innerHeight: H } = window;
    const r = t.getBoundingClientRect();
    t.style.left = `${Math.min(evt.clientX + pad, W - r.width - 8)}px`;
    t.style.top = `${Math.min(evt.clientY + pad, H - r.height - 8)}px`;
  },
  hide() { tipEl().hidden = true; },
};

/** Attach hover tooltip behavior to an element. */
export function hover(el, html) {
  el.addEventListener("pointermove", (e) => tip.show(e, typeof html === "function" ? html() : html));
  el.addEventListener("pointerleave", () => tip.hide());
}

export const debounce = (fn, ms = 120) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
