// Portfolio chat. With Claude credentials it runs a tool-use loop over the SAME tools the MCP
// server exposes, bound to the user's portfolio. Without credentials it answers common
// questions from those tools with rule-based templates (clearly labeled "offline").
// Honesty rules are identical in both modes: facts and probabilities only, never advice.
import Anthropic from "@anthropic-ai/sdk";
import { makeTools, TOOL_SCHEMAS } from "../engine/tools.js";
import { getHistory } from "./data.js";
import { searchSymbols, getProfile } from "./search.js";
import { bound, makeOfflineAnswer, preview, sanitizePortfolio } from "../engine/chat-offline.js";

export { sanitizePortfolio, signalLine, probUpPhrase } from "../engine/chat-offline.js";

const MODEL = process.env.TRL_CHAT_MODEL || "claude-opus-5-5";
const MAX_STEPS = 6;
const tools = makeTools((s) => getHistory(s), { search: (q) => searchSymbols(q), getProfile: (s) => getProfile(s) });
const offlineAnswer = makeOfflineAnswer({ tools, getHistory });

const SYSTEM = `You are the assistant inside TradeRoute Lab, an education and paper-trading tool.
Rules:
- Every number you state must come from a tool result in this conversation. Call a tool for anything quantitative.
- Never tell the user to buy, sell, hold or "should" do anything with their money, and never predict a price. Describe risks, probabilities and trade-offs neutrally, then name what the user could look at next.
- Forecasts are distributions: always give the horizon and a range or probability, never a single target.
- If a tool shows the data source as "snapshot" or "stale-cache", say the numbers aren't live.
- For "should I worry" questions, open with: "I can't tell you whether to worry, but here's what the numbers show."
- Plain language, at most about 150 words, short paragraphs or bullets. End with: "Not investment advice."`;

const hasCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export async function chat({ messages = [], portfolio: rawPortfolio = {} }) {
  const portfolio = sanitizePortfolio(rawPortfolio);
  const clean = (Array.isArray(messages) ? messages : []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!clean.length || clean.at(-1).role !== "user") throw new Error("Send at least one user message.");
  if (hasCredentials()) {
    try { return await claudeAnswer(clean, portfolio); }
    catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        const r = await offlineAnswer(clean.at(-1).content, portfolio);
        return { ...r, notice: "Claude credentials were rejected, so this is the offline answer." };
      }
      throw err;
    }
  }
  return offlineAnswer(clean.at(-1).content, portfolio);
}

async function claudeAnswer(history, portfolio) {
  const client = new Anthropic();
  const impl = bound(tools, portfolio);
  const toolDefs = Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({ name, ...t }));
  const held = Object.entries(portfolio.holdings ?? {}).filter(([, q]) => q > 0).map(([s, q]) => `${s} ${q}`).join(", ") || "none";
  const messages = [
    ...history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: `${history.at(-1).content}\n\n[Context from the app, not from the user: holdings = ${held}; cash = ${Number(portfolio.cash ?? 0).toFixed(2)}; watchlist = ${(portfolio.watchlist ?? []).join(", ")}]` },
  ];
  const trace = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: toolDefs,
      messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") return { mode: "claude", model: response.model, reply: "I can't help with that one. Try asking about your portfolio's risk, a position, or a ticker's forecast range.", toolCalls: trace };
    const uses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !uses.length) {
      let reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (response.stop_reason === "max_tokens") reply += "\n\n(Answer cut off at the length limit. Ask a narrower question.)";
      return { mode: "claude", model: response.model, reply, toolCalls: trace };
    }
    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(uses.map(async (u) => {
      try {
        if (!impl[u.name]) throw new Error(`Unknown tool ${u.name}`);
        const out = await impl[u.name](u.input ?? {});
        trace.push({ name: u.name, input: u.input, result: preview(out) });
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) };
      } catch (e) {
        trace.push({ name: u.name, input: u.input, error: e.message });
        return { type: "tool_result", tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  return { mode: "claude", model: MODEL, reply: "That needed more steps than I allow per question. Try a narrower question.", toolCalls: trace };
}
