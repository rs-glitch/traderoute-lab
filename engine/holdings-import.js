// Broker CSV import (Schwab, Fidelity, Robinhood, or any CSV with symbol + quantity columns).
// Pure and browser-safe: the file is parsed on the user's machine and never uploaded.
// Broker layouts change, so detection uses flexible header synonyms, not fixed positions.

const SYMBOL_COLS = ["symbol", "ticker", "instrument", "security symbol"];
const QTY_COLS = ["quantity", "qty (quantity)", "qty", "shares", "share quantity"];
const VALUE_COLS = ["market value", "mkt val (market value)", "current value", "value"];
const COST_COLS = ["cost basis", "cost basis total", "total cost basis", "cost basis (cb)"];
const DESC_COLS = ["description", "security description", "name"];

/** Minimal RFC-4180 CSV parser: quotes, escaped quotes, CRLF, BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/** "$1,234.50" → 1234.5 · "(12.30)" → -12.3 · "--" / "" → null */
export function num(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s || s === "--" || s.toLowerCase() === "n/a") return null;
  const neg = /\(.*\)/.test(s) || /^[^0-9]*-/.test(s); // "-$2.73", "$-150.00", "(12.30)", "$ (1,000.00)"
  s = s.replace(/[()$,%\s+-]/g, "");
  const x = Number(s);
  return Number.isFinite(x) ? (neg ? -x : x) : null;
}

const norm = (h) => h.toLowerCase().replace(/\s+/g, " ").trim();
const findCol = (header, names) => header.findIndex((h) => names.includes(norm(h)));

function detect(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = rows[i].map(norm);
    if (h.includes("trans code") && h.includes("instrument")) return { broker: "Robinhood (activity export)", headerIdx: i, kind: "activity" };
    const sym = findCol(rows[i], SYMBOL_COLS);
    const qty = findCol(rows[i], QTY_COLS);
    if (sym >= 0 && qty >= 0) {
      const broker = (h.includes("account number") || h.includes("account name") || h.some((x) => x.startsWith("account"))) && h.includes("last price") && h.includes("current value") ? "Fidelity"
        : h.some((x) => x.startsWith("qty (quantity)") || x.startsWith("mkt val")) || rows.slice(0, i).some((r) => /positions for/i.test(r.join(" "))) ? "Schwab"
        : "Generic CSV";
      return { broker, headerIdx: i, kind: "positions" };
    }
  }
  return null;
}

const CASH_RE = /^(cash|cash & cash investments|cash and cash investments|pending activity|money market|core position)/i;
const MONEY_MARKET_RE = /^[A-Z]{4,5}X?\*\*$/; // Fidelity core/money-market funds, e.g. SPAXX**
// Common sweep / money-market funds that brokers list like stocks (no "**" marker).
const MONEY_MARKET_TICKERS = new Set(["SWVXX", "SNVXX", "SNSXX", "SWTXX", "SNOXX", "FDRXX", "FZFXX", "SPRXX", "SPAXX", "FZDXX", "VMFXX", "VUSXX", "VMRXX", "TTTXX"]);
const MONEY_MARKET_DESC = /\b(money market|cash reserves|sweep|government money fund)\b/i;
const TOTAL_RE = /(account total|positions total|^total)/i;
const OPTION_RE = /\s\d{2}\/\d{2}\/\d{4}\s|\s[\d.]+\s[CP]$/; // "AAPL 01/17/2025 150.00 C"
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
/** Share classes: "BRK/B", "BRK.B", "BRK B" → "BRK-B" (the price source's format). */
export function normalizeTicker(raw) {
  const s = String(raw).trim().toUpperCase().replace(/\*+$/, "");
  const m = s.match(/^([A-Z]{1,5})[\/. ]([A-Z])$/);
  return m ? `${m[1]}-${m[2]}` : s;
}

/**
 * Parse a broker export into positions.
 * @returns {{broker, positions:[{symbol, shares, costBasis, description}], cash, warnings:string[], skipped:[{line, text, reason}]}}
 */
export function importHoldings(text) {
  const rows = parseCsv(text);
  const d = detect(rows);
  if (!d) throw new Error("Couldn't find a symbol column and a quantity column. Export the Positions view from your broker (Schwab/Fidelity), or the account activity CSV from Robinhood.");
  const header = rows[d.headerIdx];
  const out = { broker: d.broker, positions: [], cash: 0, warnings: [], skipped: [] };
  const agg = new Map();
  const add = (symbol, shares, costBasis, description) => {
    const cur = agg.get(symbol) ?? { symbol, shares: 0, costBasis: 0, description, costKnown: true };
    cur.shares += shares;
    if (costBasis == null) cur.costKnown = false; else cur.costBasis += costBasis;
    agg.set(symbol, cur);
  };
  const skip = (i, r, reason) => out.skipped.push({ line: i + 1, text: r.slice(0, 3).join(" · "), reason });

  if (d.kind === "activity") {
    // Robinhood: rebuild positions from Buy/Sell rows. Splits and transfers can't be fully reconstructed.
    const c = (name) => findCol(header, [name]);
    const [iSym, iCode, iQty, iAmt] = [c("instrument"), c("trans code"), c("quantity"), c("amount")];
    let costMap = new Map();
    let optionRows = 0;
    for (let i = d.headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const code = (r[iCode] || "").toUpperCase();
      const sym = (r[iSym] || "").toUpperCase();
      if (code === "BUY" || code === "SELL") {
        const q = Math.abs(num(r[iQty]) ?? 0);
        if (!TICKER_RE.test(sym) || !q) { skip(i, r, "unreadable trade row"); continue; }
        const signed = code === "BUY" ? q : -q;
        add(sym, signed, null, "");
        costMap.set(sym, (costMap.get(sym) ?? 0) + (code === "BUY" ? Math.abs(num(r[iAmt]) ?? 0) : 0));
      } else if (["BTO", "STO", "BTC", "STC", "OEXP", "OASGN", "OEXCS"].includes(code)) {
        optionRows++;
      } else if (["SPL", "SPR", "ACATI", "ACATO", "SXCH", "MRGS"].includes(code)) {
        out.warnings.push(`Line ${i + 1}: ${code} (split/transfer/merger) for ${sym || "?"} can't be reconstructed from activity. Check that position's share count by hand.`);
      }
    }
    if (optionRows) out.warnings.push(`${optionRows} option trade rows were ignored (options aren't supported).`);
    out.warnings.push("Robinhood exports account activity, not positions. Positions were rebuilt from buys and sells in the file's date range, and cash isn't included. Export the full account history for accurate share counts.");
  } else {
    const iSym = findCol(header, SYMBOL_COLS);
    const iQty = findCol(header, QTY_COLS);
    const iVal = findCol(header, VALUE_COLS);
    const iCost = findCol(header, COST_COLS);
    const iDesc = findCol(header, DESC_COLS);
    for (let i = d.headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const raw = (r[iSym] || "").trim();
      const desc = iDesc >= 0 ? r[iDesc] : "";
      if (!raw && !desc) continue;
      if (TOTAL_RE.test(raw) || TOTAL_RE.test(desc)) { skip(i, r, "total row"); continue; }
      if (CASH_RE.test(raw) || CASH_RE.test(desc) || MONEY_MARKET_RE.test(raw) || MONEY_MARKET_TICKERS.has(raw.toUpperCase()) || MONEY_MARKET_DESC.test(desc)) {
        const v = num(r[iVal]) ?? num(r[iQty]);
        if (v != null) out.cash += v;
        continue;
      }
      if (OPTION_RE.test(raw)) { skip(i, r, "option contract (not supported)"); continue; }
      const sym = normalizeTicker(raw);
      const q = num(r[iQty]);
      if (!TICKER_RE.test(sym)) { skip(i, r, "not a ticker"); continue; }
      if (q == null || q === 0) { skip(i, r, "no quantity"); continue; }
      if (q < 0) { out.warnings.push(`${sym}: short position (${q}) imported. Paper trading doesn't simulate shorts.`); }
      add(sym, q, iCost >= 0 ? num(r[iCost]) : null, desc);
    }
  }

  for (const p of agg.values()) {
    const shares = Math.round(p.shares * 1e6) / 1e6;
    if (Math.abs(shares) < 1e-9) continue; // fully sold
    if (shares < 0 && d.kind === "activity") {
      out.warnings.push(`${p.symbol}: more shares sold than bought in this file (${shares}). Shares bought before the export's date range? It's left out; enter the real count by hand.`);
      out.skipped.push({ line: 0, text: p.symbol, reason: "negative position from partial history" });
      continue;
    }
    out.positions.push({ symbol: p.symbol, shares, costBasis: p.costKnown ? Math.round(p.costBasis * 100) / 100 : null, description: p.description });
  }
  out.positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  out.cash = Math.round(out.cash * 100) / 100;
  if (!out.positions.length) throw new Error("No stock or ETF positions found in that file.");
  return out;
}
