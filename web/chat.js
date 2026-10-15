// Portfolio chat drawer. The server answers with Claude + tools, or offline rule-based answers.
// Every answer shows which tools produced its numbers.
import { $, esc } from "./ui.js";

const SUGGESTIONS = ["Should I be worried about my NVDA position?", "How diversified is my portfolio?", "What's the outlook range for AAPL next month?", "Do any trading signals work on MSFT?", "Find the ticker for Tesla"];

export function createChat(ctx) {
  const drawer = $("#chat");
  const log = $("#chat-log");
  const form = $("#chat-form");
  const input = $("#chat-input");
  const history = [];
  let busy = false;

  const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  const add = (cls, html) => { const el = document.createElement("div"); el.className = `msg ${cls}`; el.innerHTML = html; log.append(el); log.scrollTop = log.scrollHeight; return el; };

  function renderEmpty() {
    log.innerHTML = `<p class="sub">Ask about your portfolio or any ticker. Answers use the same tools as the MCP server, and they're facts and probabilities, not advice.</p>
      <div class="chips">${SUGGESTIONS.map((s) => `<button class="btn small" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div>`;
    for (const b of log.querySelectorAll("[data-s]")) b.addEventListener("click", () => ask(b.dataset.s));
  }

  async function ask(q) {
    if (busy || !q.trim()) return;
    open();
    if (!history.length) log.innerHTML = "";
    busy = true;
    history.push({ role: "user", content: q });
    add("user", esc(q));
    const wait = add("bot thinking", "Checking the numbers…");
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history, portfolio: { holdings: ctx.state.holdings, cash: ctx.state.cash, watchlist: ctx.state.watchlist } }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
      wait.remove();
      history.push({ role: "assistant", content: r.reply });
      const tools = (r.toolCalls ?? []).map((t) => `<details><summary>${esc(t.name)}(${esc(JSON.stringify(t.input ?? {}))})${t.error ? " · error" : ""}</summary><pre>${esc(t.error ?? t.result ?? "")}</pre></details>`).join("");
      add("bot", `${md(r.reply)}${tools ? `<div class="tools"><span class="sub">Numbers from:</span>${tools}</div>` : ""}<div class="mode sub">${r.mode === "claude" ? `Claude (${esc(r.model || "")})` : "offline mode"}${r.notice ? ` · ${esc(r.notice)}` : ""}</div>`);
    } catch (e) {
      wait.remove();
      history.pop();
      add("bot", `Sorry, that failed: ${esc(e.message)}`);
    }
    busy = false;
  }

  function open() { drawer.hidden = false; $("#chat-fab").setAttribute("aria-expanded", "true"); input.focus(); }
  $("#chat-fab").addEventListener("click", () => { if (drawer.hidden) { open(); if (!history.length) renderEmpty(); } else { drawer.hidden = true; $("#chat-fab").setAttribute("aria-expanded", "false"); } });
  // Shrink the button to its icon once the reader scrolls, so it covers less of the page.
  const fab = $("#chat-fab");
  const compact = () => fab.classList.toggle("compact", scrollY > 120);
  addEventListener("scroll", compact, { passive: true }); compact();
  $("#chat-close").addEventListener("click", () => { drawer.hidden = true; $("#chat-fab").setAttribute("aria-expanded", "false"); });
  form.addEventListener("submit", (e) => { e.preventDefault(); const q = input.value; input.value = ""; ask(q); });
  renderEmpty();
  return { ask, open };
}
