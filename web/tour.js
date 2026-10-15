// Guided demo: drives the real app through the app's own API. Narration numbers are computed
// live from the engine. Sequence guard for fast clicks; each step sets the full state it needs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

export function createTour({ state, showTab, selectTicker, setPrefs, executeAll, getAnalysis, getPlan, E, importSample, ask, ensureMeta }) {
  let steps = null;
  let i = 0;
  let seq = 0;
  let timer = null;
  let raf = 0;
  let target = null;
  let active = false;
  let autoplay = true;
  const HERO = () => (state.data.has("NVDA") ? "NVDA" : state.watchlist[0]);
  const prefsFor = (patch) => ({ ...E.DEFAULT_PREFS, ...patch });

  function build() {
    const sym = HERO();
    setPrefs(prefsFor({})); // demo runs on default preferences
    const a = getAnalysis(sym);
    const nSig = state.watchlist.length * 4;
    let evidence = 0;
    for (const s of state.watchlist) if (state.data.has(s)) evidence += getAnalysis(s).signals.filter((x) => x.verdict.level === "evidence").length;
    return [
      { title: "Most trading tools promise a price. This one shows the odds.", body: "TradeRoute Lab pulls live market data, tells you how uncertain the future is, grades every trading signal honestly, and turns <b>your</b> preferences into risk-bounded trade routes. Everything is paper trading.", action: () => showTab("market") },
      { title: "Start from the portfolio you actually have", target: "#home-portfolio", body: () => { const n = Object.keys(state.holdings).length; return `Import a Schwab, Fidelity or Robinhood CSV. It's parsed in your browser and never uploaded. Here's a sample Schwab account: ${n} positions plus cash, graphed over the past year next to the S&amp;P 500.`; }, action: async () => { await importSample("schwab-positions"); showTab("market"); await sleep(400); } },
      { title: "What the market is doing right now", target: "#home-market", body: "Major indexes, the VIX fear gauge and the 10-year yield, plus today's move in every sector, sorted. It refreshes every minute while this page is open, and the badge shows whether the market is open.", action: () => showTab("market") },
      { title: "Where your money is, and where your risk is", target: "#p-exposure-head", body: async () => "", bodyFrom: "exposure", action: async () => { showTab("exposure"); await sleep(900); } },
      { title: "Live data, with its provenance", target: "#p-market", body: () => { const all = [...state.data.values()]; const lv = all.filter((d) => d.source === "live" || d.source === "cache").length; return `${lv} of ${all.length} tickers are ${lv === all.length ? "live" : "live; the rest come from a saved real snapshot"}, each split- and dividend-adjusted. The badge in the header always shows the source and date, and today's unfinished bar is kept out of every statistic.`; }, action: () => showTab("market") },
      { title: "Diversification you can see", target: "#p-corr", body: "Recent-weighted correlations. Bonds (TLT) and gold (GLD) move differently from tech, and those pale and red cells are what keeps a portfolio's risk down.", action: () => showTab("market") },
      { title: `${sym}: the facts first`, target: "#p-tstats", body: `Up ${pct(a.stats.return1y)} over a year, but with ${pct(a.stats.volNow)} annualized volatility right now and a worst peak-to-trough drop of ${pct(Math.abs(a.stats.maxDrawdown))} in five years.`, action: () => selectTicker(sym) },
      { title: "A forecast is a range, not a target", target: "#p-fan", body: `2,000 simulated paths. Chance ${sym} is higher in ${a.forecast.horizon} trading days: <b>${pct(a.forecast.probUp)}</b>. The 90% range runs from ${pct(a.forecast.band90[0])} to +${pct(a.forecast.band90[1])}.`, action: () => selectTicker(sym) },
      { title: "Is the range honest? We checked.", target: "#calib-tile", body: `Rolling back through history and forecasting with only the data available at the time, <b>${pct(a.calibration.coverage)}</b> of ${a.calibration.origins} outcomes landed inside the 90% band. A calibrated forecast should score about 90%.`, action: () => selectTicker(sym) },
      { title: "Do trading signals actually work?", target: "#p-signals", body: `Momentum, trend and mean reversion are tested out of sample against buy &amp; hold scaled to the same exposure, with a t &gt; 3 bar. Across the watchlist, <b>${evidence} of ${nSig}</b> signal/ticker pairs clear it. That's what the research predicts, so the planner won't bet on signals without evidence.`, action: () => selectTicker(sym) },
      { title: "Your preferences drive the plan", target: "#p-prefs", body: "Cash, risk appetite, horizon, style, position cap and long-only. Every change re-plans instantly, in your browser.", action: async () => { setPrefs(prefsFor({ risk: 2 })); await sleep(300); showTab("plan"); } },
      { title: "A conservative plan", target: "#p-alloc", body: () => { const p = getPlan().plan; return `Risk 2 targets ${pct(p.targetVol)} volatility and reaches ${pct(p.expectedVol, 1)}, with ${pct(p.cash)} in cash. Bars show each weight; orange ticks show each asset's share of the <i>risk</i>, which is roughly equal by design.`; }, action: async () => { setPrefs(prefsFor({ risk: 2 })); await sleep(300); showTab("plan"); } },
      { title: "Turn the dial to aggressive", target: "#p-plan-head", body: () => { const p = getPlan().plan; return `Risk 5 targets ${pct(p.targetVol)}. The plan tilts toward higher-volatility names and reaches ${pct(p.expectedVol, 1)}. ${p.reachesTarget ? "" : "The target can't be reached without leverage at this position cap, and the tool says so instead of pretending."}`; }, action: async () => { setPrefs(prefsFor({ risk: 5 })); await sleep(300); showTab("plan"); } },
      { title: "Trade routes: sized, stopped, and honest about the odds", target: "#p-routes", body: () => { const o = getPlan().routes.orders.find((x) => x.route); return o ? `Sells first, then buys. ${o.symbol}: stop ${o.route.stop.toFixed(2)}, target ${o.route.target.toFixed(2)}, risking ${Math.round(o.route.riskDollars).toLocaleString()} dollars. P(target first) <b>${pct(o.route.pTarget)}</b> vs P(stop first) ${pct(o.route.pStop)}. A 1.5:1 payoff costs you hit rate.` : "Already at target."; }, action: async () => { setPrefs(prefsFor({ risk: 5 })); await sleep(300); showTab("plan"); } },
      { title: "Execute on paper", target: "#p-paper", body: "One click fills every route in a simulated account at live prices, with slippage and costs. Quotes refresh every minute, and stops and targets trigger automatically. No order ever leaves your browser.", action: async () => { showTab("plan"); await sleep(200); executeAll(); showTab("paper"); } },
      { title: "Ask it, in plain English", target: "#chat", body: "\"Should I be worried about my NVDA position?\" The answer comes from the same tools the MCP server exposes, using your real numbers. It's facts and probabilities, never advice, and you can open each tool call to see where every number came from.", action: async () => { await ask("Should I be worried about my NVDA position?"); await sleep(600); }, dwell: 14000 },
      { title: "Same engine, for AI agents", body: "The engine is also an MCP server with 7 tools, including get_portfolio_exposure, position_risk and search_symbols, the same ones behind the chat box. Any agent can ask it the same questions. Methods lists the equations, the checks and the sources. <b>Education &amp; simulation only, not investment advice.</b>", action: () => showTab("methods"), final: true },
    ];
  }

  const spot = document.createElement("div");
  spot.className = "tour-spot";
  spot.hidden = true;
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  card.hidden = true;
  document.body.append(spot, card);

  function place() {
    if (!active) return;
    const el = target && document.querySelector(target);
    if (el) {
      const r = el.getBoundingClientRect();
      Object.assign(spot.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      spot.classList.remove("full");
      card.classList.toggle("left", r.left + r.width / 2 >= window.innerWidth / 2);
    } else { spot.classList.add("full"); card.classList.remove("left"); }
    spot.hidden = false;
    raf = requestAnimationFrame(place);
  }

  function render(s) {
    let body = typeof s.body === "function" ? s.body() : s.body;
    if (s.bodyFrom === "exposure") {
      const flags = [...document.querySelectorAll("#p-exposure-head .flags li.warn")].map((li) => li.textContent.replace(/^\W+/, "").trim());
      body = `Positions by value <i>and</i> by share of risk, from recent-weighted correlations. ${flags.length ? `What stands out here: ${flags.slice(0, 2).join(" ")}` : "No concentration warnings on this portfolio."}`;
    }
    const dwell = s.dwell ?? Math.max(7000, body.replace(/<[^>]+>/g, "").split(/\s+/).length * 260);
    card.innerHTML = `<div class="tour-meta"><span>${i + 1} / ${steps.length}</span><span>← → Esc</span></div><h3>${s.title}</h3><p>${body}</p>
      <div class="tour-bar"><i style="animation-duration:${dwell}ms;${autoplay && !s.final ? "" : "animation:none;width:0"}"></i></div>
      <div class="row"><button class="btn" data-t="back" ${i === 0 ? "disabled" : ""}>← Back</button>
      ${s.final ? `<button class="btn primary" data-t="end">Explore on your own</button><button class="btn" data-t="replay">↻ Replay</button>` : `<button class="btn primary" data-t="next">Next →</button><button class="btn" data-t="auto">${autoplay ? "❚❚ Pause" : "▶ Autoplay"}</button>`}
      <span class="spacer"></span><button class="btn" data-t="end" aria-label="Exit demo">✕</button></div>`;
    for (const b of card.querySelectorAll("[data-t]")) b.addEventListener("click", () => handlers[b.dataset.t]());
    clearTimeout(timer);
    if (autoplay && !s.final) timer = setTimeout(() => goto(i + 1), dwell);
  }

  async function goto(k) {
    if (!active || k < 0 || k >= steps.length) return;
    const my = ++seq;
    i = k;
    const s = steps[i];
    clearTimeout(timer);
    card.classList.add("busy");
    target = null;
    try { await s.action?.(); } catch (e) { console.error(e); }
    await sleep(250);
    if (my !== seq) return;
    target = s.target ?? null;
    const el = target && document.querySelector(target);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); await sleep(450); }
    if (my !== seq) return;
    card.classList.remove("busy");
    render(s);
  }

  const handlers = { next: () => goto(i + 1), back: () => goto(i - 1), auto: () => { autoplay = !autoplay; render(steps[i]); }, replay: () => { autoplay = true; goto(0); }, end: () => stop() };
  const onKey = (e) => {
    if (!active) return;
    if (e.key === "ArrowRight") handlers.next();
    else if (e.key === "ArrowLeft") handlers.back();
    else if (e.key === "Escape") stop();
  };

  function start() {
    steps = build();
    active = true;
    autoplay = true;
    card.hidden = false;
    document.addEventListener("keydown", onKey);
    cancelAnimationFrame(raf);
    place();
    goto(0);
  }
  function stop() {
    active = false;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    card.hidden = true;
    spot.hidden = true;
    document.removeEventListener("keydown", onKey);
  }
  return { start, stop };
}
