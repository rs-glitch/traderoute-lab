# Coordinator Review #1: TradeRoute Lab engine (2026-09-23, ~19:25 PDT)

**Bottom line:**
- **The backtest has no lookahead, and the forecast bands are roughly calibrated.** The perturbation test found 0 violations, and 90% bands covered 87–96% of outcomes.
- **Three things the user will see are wrong or misleading:**
  - the "risk-parity" solver does not converge;
  - the hit-rate significance test calls buy-and-hold "significant";
  - "Underperforms buy & hold" measures lower market exposure, not negative skill.
- Fix these three before the UI shows them.

**Scope and method:**
- **Audited:** `engine/{stats,forecast,signals,backtest,portfolio,routes}.js` and `server/data.js`, as they were at 19:22. `web/`, `test/`, `server/http.js` and `server/mcp.js` did not exist yet, so the UI copy has not been audited.
- **How:** every number below was reproduced with `node --input-type=module -e` against `data/snapshot/*.json`:
  - real Yahoo bars, 1,254 per symbol, 2021-09-24 → 2026-09-23;
  - the backtest window after warm-up is 2022-09-28 → 2026-09-23;
  - one live request to confirm the endpoint.

## Findings (ranked by severity)

### 1. HIGH: The "equal risk contribution" base does not converge, so every plan is a near-corner portfolio (`engine/portfolio.js` `ercWeights`)
- **Evidence:** 11-symbol universe, same covariance matrix. Weight / risk share by iteration count:
  - 1 iteration: XOM 100% / 100%;
  - 50 iterations: TLT 94.6% / 95.7%;
  - 500 iterations (the default): **QQQ 36.2% / 48.1%, TLT 61.4% / 49.7%**, everything else under 1%, and XOM and GLD at 0.0%.
- **Effect on the default plan (`buildPortfolio(all11, {})`):** XOM 0%, GLD 0%, QQQ carries 29% of the risk while MSFT carries 7%. Caps and vol-scaling hide the problem, but the rationale string still tells the user "x% risk-parity base".
- **Cause:** the fixed-point update `w ← w·sqrt((total/n)/(w·m))` is undamped and oscillates. There is no convergence check. Negative marginal risk (TLT against equities) is clamped to 1e-12, which blows the weight up.
- **Fix:**
  - Replace it with a convergent solver: cyclical coordinate descent on the ERC objective, or a damped update `w ← w·(b/rc)^0.5` averaged with the previous w and stopped when max|rc − 1/n| < 1e-4.
  - Return `converged` and the iteration count, and fall back to inverse-vol if it fails.
  - **Add a property test:** for random positive-definite covariance matrices, every risk contribution is within 1% of 1/n.
- **Confidence:** high.

### 2. HIGH: The binomial hit-rate test measures the market's up-day rate, not skill (`engine/backtest.js` `hitP`)
- **Evidence:** it tests sign agreement against p = 0.5. Long-only positions agree with the market's up days.
  - Buy-and-hold NVDA: hit 0.544, **p = 0.0065**.
  - JPM momentum: hit 0.565, p < 0.001, while the base up-day rate is 0.569, so it is *worse* than always-long.
  - 22 of 44 signal×ticker grades have p < 0.05, yet only 1 of the 44 has a positive t against buy-and-hold (TLT, t = 0.04).
- **Fix:**
  - Test the hit rate against the **base rate of up days over the same held days**, for example a two-proportion test or `binomTestP(k, n, baseUp)`. Otherwise drop the test.
  - Never show a hit-rate p-value next to the word "skill".
  - Note that daily observations are not independent when positions persist.
- **Confidence:** high.

### 3. HIGH / MEDIUM: "Underperforms buy & hold" is mostly lower exposure in a bull window, not negative skill (`backtest.js` `verdictFor`, `tVsBenchmark`)
- **Evidence:** 16 of 44 grades read "Underperforms" (t < −2). Exposure is 0.85–0.90 for trend and momentum and 0.46 for balanced. Flat days earn 0% while T-bills paid around 4–5%.
  - Once cash earns 4% (an illustrative assumption) and the benchmark exposure is removed (alpha t-stat), SPY balanced goes from −2.48 to −0.44, NVDA balanced from −3.55 to −1.02 and GLD momentum from −2.13 to −1.40.
  - Every case checked lands between −1.4 and +0.2, which is "no evidence either way".
  - The thresholds are also asymmetric: a positive verdict needs t > 3, while a negative one needs only t < −2 with no multiple-testing correction.
- **Fix:**
  - Grade on beta-adjusted alpha (strategy excess return minus β·benchmark excess return).
  - Credit cash at a stated risk-free rate, or label it "cash earns 0%".
  - Use a symmetric |t| > 3 hurdle.
  - Label the result "No reliable difference" unless it clears the hurdle.
  - Say which window was tested (Sep 2022 – Sep 2026, a strong bull market).
- **Confidence:** high on the mechanism. The 4% cash rate is an assumption (UNVERIFIED average).

### 4. MEDIUM: The FHS residual pool is not re-centered, so there is a hidden drift and even a symmetric route isn't about 50% (`engine/forecast.js` `fhsModel`)
- **Evidence:** `z = (r − μ)/σ_{t−1}` does not have mean 0 because σ varies. mean(z) is −0.010 for SPY, +0.008 for NVDA and +0.001 for TLT. At today's σ that is an **unshrunk extra drift**: −1.9%/yr for SPY and +4.5%/yr for NVDA, on top of the "shrunk" drift.
- **Symmetric first-passage check:** zero explicit drift, ±5%, 252 days, 4,000 paths. The result was pTarget 0.446 vs pStop 0.496. Log-space asymmetry alone would favor the target. (This check is the one in PLAN.md M3: "symmetric route ≈ 50%".)
- **Fix:** `z = z.map(x => x − mean(z))`, and optionally rescale to unit variance. Add the symmetric-route test with a tolerance of about ±2pp at 4,000 paths.
- **Confidence:** high.

### 5. MEDIUM: The forecast drift comes from hindsight-picked winners, which inflates P(target) (`forecast.js` `DRIFT_SHRINK = 0.25` × the full-sample mean)
- **Evidence:** the explicit drift is +11.7%/yr for NVDA and +6.1% for XOM. Adding finding #4, NVDA's drift is about 16%/yr.
- **Effect on SPY at 1.5:1 reward:risk over 252 days:** pTarget is **0.32 with zero drift** and **0.41 with model drift**. The drift, not the data's volatility, moves the probability.
- **Fix:**
  - Default the drift to 0, or to a common, cited equity premium applied to every stock.
  - Show a "drift assumption" toggle in the UI.
  - State the survivorship caveat: the universe was chosen in 2026.
- **Confidence:** high on the numbers. What drift to use is a product decision.

### 6. MEDIUM: Position caps break when they are infeasible (`portfolio.js` `capWeights` + renormalize)
- **Evidence:**
  - 3 names with a 0.25 cap: max weight **0.327**.
  - 2 names with a 0.30 cap: max weight **0.490**.
  - When n·cap < 1, the loop has no free names left, and the renormalization (`w / gross`) undoes the cap.
- **Fix:** when n·cap < 1, cap each name and hold the rest as cash. Add a property test that every weight is ≤ cap for any n. This is PLAN M3's exit criterion.
- **Confidence:** high.

### 7. MEDIUM: Live-data labeling: no partial-bar flag, and old caches look fresh (`server/data.js`)
- **Evidence (from reading the code, plus one live request):**
  - During market hours the last daily bar is incomplete. It is timestamped 13:30Z whether or not the session is over. `meta.currentTradingPeriod.regular.end` is present in the response, but it isn't used.
  - On a live failure, a disk cache of **any age** is returned as `source: "cache"`.
  - `q.open[i]` throws if `open` is missing.
  - `saveSnapshot` skips a symbol that was just served from memory.
- **Fix:**
  - Add `partialBar: now < currentTradingPeriod.regular.end` and exclude that bar from signals and backtests.
  - Add `ageMinutes`, with a STALE label past the TTL.
  - Use `q.open?.[i]`.
  - Force a live fetch in `saveSnapshot`.
- **Confidence:** high (code). Partial-bar behavior during market hours was not observed live.

### 8. LOW / MEDIUM: The evidence tilt fires below the hurdle (`portfolio.js`)
- **Evidence:** `evidence = clamp(t/3, 0, 1)`, so t = 1 gives a 33% tilt. That contradicts "without evidence there is no tilt" and the t > 3 story. Today it is mostly moot: only TLT has t > 0 (0.04).
- **Fix:** set evidence to 0 below the hurdle (or below the multiple-testing-adjusted hurdle for the number of symbol×signal trials, currently 44), or relabel the tilt as "exploratory".
- **Confidence:** high.

### 9. LOW: The "Tested" claim has no test yet, and buy-and-hold shows t = NaN (`backtest.js` header, `verdictFor`)
- **Evidence:** the header says "tested: perturbing future prices never changes past results", but `test/` is empty.
  - The coordinator ran that perturbation test itself: 4 signals × cut points {300, 700, 1100} on AAPL gave **0 violations** in both positions and equity. So the claim is true, just not yet gated.
  - `backtest(buyhold)` gives `verdict: "No evidence of skill vs buy & hold (t = NaN)"`.
- **Fix:** commit the perturbation test. Guard against a zero-variance difference ("identical to benchmark").
- **Confidence:** high.

### 10. LOW: Signal attribution and one small lookahead
- **Signal attribution:** "Time-series momentum (12-1)" cites Jegadeesh & Titman (1993). That paper is **cross-sectional** momentum (SOURCES.md #2). Time-series momentum (Moskowitz, Ooi & Pedersen 2012) uses a 12-month lookback with vol scaling.
  - **Fix:** cite MOP alone and call the signal "12-1 absolute momentum (skip-month variant)".
- **Small lookahead:** `ewmaVol` seeds its variance with the std of the first 20 returns. As a result, σ[0..18] depends on later returns: changing r[15] moves σ[0] from 0.0068 to 0.0439. FHS residuals start at t = 20, and nothing downstream reads early σ today, so the effect is nil for now.
  - **Fix:** seed with r[0]² or mark σ[t < warm] as null.
- **Confidence:** high.

## Verified OK (reproduced)

**Backtest and forecast**
- **Backtest alignment:** `strat[t] = pos[t−2]·r[t]`, meaning the signal is formed at close t, traded at close t+1 and earns r(t+2). The perturbation test found 0 lookahead violations. Costs are charged on turnover.
- **Annualization:** one constant, `TRADING_DAYS = 252`, used in √252 vol and Sharpe, CAGR exponent 252/(n−1), and EWMA covariance × 252.
- **SPY check:** vol 17.2%, Sharpe 0.80 and max DD −24.5% are plausible.
- **Statistical helpers:** `binomTestP(60, 100) = 0.0569`, which matches the exact two-sided value. `normCdf(1.96) = 0.97500`. EWMA λ = 0.94 matches RiskMetrics (SOURCES #9).
- **FHS causality:** standardization uses σ_{t−1}, and `calibrate` only sees `closes.slice(0, o+1)`.
- **Calibration:** 90% bands at a 21-day horizon over 47 non-overlapping origins covered SPY 95.7%, AAPL 93.6%, NVDA 93.6%, TLT 95.7% and XOM 87.2%.
  - The 95% sampling interval at n = 47 is about ±8.6pp, so these are consistent with calibration and can't tell apart slight over-coverage.
  - Misses are mostly on the upside (e.g. NVDA 6.4% above, 0% below), which fits finding #5.
- **Determinism:** the same seed gives an identical `band90`.

**Portfolio and routes**
- **Vol targeting:** the default plan hit 12.0% realized ex-ante vol against a 12% target. Risk contributions sum to 1.000. There is no leverage (gross ≤ 0.98).
- **Routes:**
  - sells come before buys;
  - cash never goes negative (min $8,295 on the test route);
  - the per-trade risk cap and the exit-if-not-in-plan logic work;
  - each route has a "paper trading only, not investment advice" note;
  - `pNeither` is reported alongside pTarget and pStop (it was 0.29–0.59 in the test, so the UI must show all three).

**Data and inputs**
- **Snapshot data:** the snapshot is real market data. AAPL shows its 2025-04-09 jump (+14.3% log return). There are 0 bars with high < low, and OHLC is back-adjusted by adjclose/close.
- **Live endpoint:** HTTP 200 on 2026-09-23 (1 request).
- **Input validation:** the symbol regex validates input, and requests time out after 8 s.

## Not yet audited (next milestone)
- `web/` copy: the words "target price", "prediction", "signal says buy", and whether the disclaimer is on every surface.
- The MCP tool outputs, and whether they carry the disclaimer.
- The paper-trading simulator: fills at the limit or at the close, and gap-through-stop handling.
- The guided tour's narration, and whether it is computed from the engine.
- `npm test`.

## Final audit (2026-09-23, ~21:15 PDT, coordinator run 2)

**Bottom line:**
- **The engine is now sound.** All 3 previous HIGH findings reproduce as fixed, as do MEDIUM #4, #6, #7 and LOW #8, #10. `npm test`: 18/18 pass.
- **The paper-trading layer is the weakest part.**
  - "Execute all" can be applied twice, and the paper book is separate from the holdings the plan is built on.
  - Fills ignore the route's limit, stop and target geometry.
- **Some UI copy claims more than the code does:**
  - "equal risk… no single asset dominates" appears on every plan;
  - the calibration range and "12 verified sources" are stale;
  - performance numbers have no "hypothetical" label or date window.

**Scope and method:**
- **Files read:** `engine/*`, `server/{data,http,mcp}.js`, `web/{app,tour,methods,index.html}`, `README.md` and `test/`.
- **How:** reproductions ran with `node` on `data/snapshot/*.json` (real bars, 2021-09-24 → 2026-09-23, 1,254 per symbol). The backtest window after warm-up is **2022-09-28 → 2026-09-23 (1,000 days)**.
- **Server:** 2 GETs to the running server on :4174 (`/api/history?symbol=NVDA` gave `source: live`; `/api/quotes`). The market was closed, so partial-bar exclusion was tested with a mocked payload instead.
- **Paper trading:** tested with a line-for-line replica of `executeAll` (`web/app.js` 253–278), because app.js needs a DOM.

### Previous findings: status (reproduced)

| # | Finding | Status | Reproduction |
|---|---|---|---|
| 1 HIGH | ERC does not converge | **FIXED** | On the 11-asset EWMA covariance, max \|rc − 1/n\| is 4.5e-4 after 5 sweeps and 3e-14 after 20. Weights run from 0.043 to 0.218, with no corner. On 200 random PD matrices (n = 2–13), the worst relative risk-contribution error is 0.21%. Residue: see F8. |
| 2 HIGH | Hit rate tested against 0.5 | **FIXED** | NVDA buy & hold: hit 0.544 = base 0.544, p = 1.000. 0 of 44 grades have hitP < 0.05 (the old result was 22 of 44). |
| 3 HIGH | Exposure read as skill; asymmetric verdicts | **FIXED** | The benchmark is exposure-matched, the threshold is a symmetric \|t\| > 3, and the default label is "No reliable difference". All 44 grades are `none`, with t from −1.61 to +1.90. Buy & hold gives t = 0.00, not NaN. |
| 4 MED | FHS hidden drift | **FIXED** | mean(z) is ~1e-17 and the drift is 0. On a symmetric ±10% bracket over 252 days, NVDA gives pT 0.490 vs pS 0.503. |
| 5 MED | Hindsight drift | **FIXED** | `DRIFT_SHRINK = 0`, disclosed in Methods. |
| 6 MED | Infeasible caps | **FIXED** | n = 3 with a 0.25 cap: max 0.250, cash 0.250. n = 2 with a 0.30 cap: max 0.300, cash 0.400. |
| 7 MED | Partial bar / stale cache | **FIXED** (except `q.open`) | Mocked in-session payload: 3 rows became 2 bars plus `intraday`. `stale-cache` is labeled with `ageMinutes`. `parseChart` still throws when `open` is missing. |
| 8 LOW | Tilt below the hurdle | **FIXED** | Evidence is `(t−2)/(3−2)` clamped. Today no symbol is tilted. The portfolio.js header comment still says `clamp(t/3)`. |
| 9 LOW | No committed perturbation test | **FIXED** | The `NO LOOKAHEAD` test passes. |
| 10 LOW | Momentum citation; ewmaVol seed | **Citation FIXED.** Seed remains, with nil effect: FHS reads σ from t ≥ 19. | — |

### Findings (ranked by severity)

**F1. HIGH: The paper book is disconnected from the plan, and "Execute all" is not idempotent** (`web/app.js` 221, 253–278; `tour.js` step 12)
- **Evidence:**
  - `getPlan()` sizes orders against the *rail* `state.holdings` and `state.cash`. `executeAll()` books them into `state.paper`, and it never updates `state.holdings` or clears `state.plan`.
  - **Double execution.** A second click, or a tour replay (step 12 calls `executeAll`), re-sends every buy until cash runs out.
    - Replica with default prefs and $100k: after 2 executes, **XOM is 28.7%, above its 25% cap, and cash is 0.1%, below the 2% floor**.
  - **Holdings mismatch.** If the user enters holdings in the rail, the paper book doesn't have them. The plan's sells become no-ops (`min(o.shares, pos.shares) = 0`), and its buys are only deltas, so the paper book ends up under-invested.
- **Fix:**
  - Plan against the paper book when executing (holdings = paper positions, cash = paper cash).
  - After execution, set `state.plan = null`. A second click on an up-to-date plan should give "Already at target".
  - Add a test: execute twice → second execution has 0 orders.
- **Confidence:** high (code path plus replica).

**F2. MEDIUM/HIGH: Paper fills ignore the route's limit, and the stop and target stay anchored to yesterday's close** (`app.js` 258, 266)
- **Evidence:**
  - Routes use `bars.at(-1).c`, the last *completed* close. Paper fills at `lastPrice()`, which is the live quote, × 1.001, with no check against `o.limit`.
  - The stop and target are copied from the route unchanged.
  - With the quote 3% above the close, XOM fills at 166.23 against a displayed "≤ 161.39" limit. Risk per share becomes 14.43 against 9.58 planned (+51%), so the "stop-out loses ≤ 1.5%" promise is broken.
  - With the quote 10% below, the fill (145.25) is already under the stop (151.81), and the position is stopped out at the next mark.
- **Fix:**
  - Fill only if the price is at or through the limit; otherwise log "limit not reached".
  - Alternatively, re-anchor the stop and target to the fill price and re-size to the risk budget.
- **Confidence:** high.

**F3. MEDIUM: "Built from equal risk contributions, so no single asset dominates the risk" is shown on every plan, but it is false at the default risk level** (`app.js` 235)
- **Evidence:**
  - Default plan (risk 3, 12% target): the vol-seeking γ tilt gives **NVDA 32.4% and AMZN 22.1% of the risk, while SPY has 0.6% and TLT 0.4%**. XOM has 24.5% of the weight but 2.6% of the risk.
  - At risk 2 the contributions are equal (all 9.1%), so tour step 9 is correct.
- **Fix:** when `riskTiltGamma > 0`, say "Starts from equal risk; to reach your X% target without leverage, risk was shifted toward higher-volatility names (largest: NVDA 32%)."
- **Confidence:** high.

**F4. MEDIUM: Headline numbers are stale or over-verified** (README 4–5 and 54; `methods.js` 6–7; `tour.js` 41; `mcp.js` 24)
- **Calibration:**
  - At the UI setting (h = 21, step 10), 90% coverage is **86–98%** (GLD 85.9%, TLT 98.0%). The copy says "87–96%".
  - The "~99 origins" overlap (21-day horizon, 10-day step), so the effective n is about 47. The ±~8pp sampling error is not stated in the README or the UI tile.
  - Misses are mostly on the upside (NVDA 8% above / 0% below; GLD 12% / 2%), consistent with zero drift in a bull window. That is fine, but worth one sentence.
- **Sources:** "12 verified sources": Methods lists Griveau-Billion, Richard & Roncalli (2013), which is **not in SOURCES.md**. Status: UNVERIFIED.
- **MCP:** the `backtest_signal` description still says "t-stat vs buy & hold". It should say exposure-matched.
- **Fix:** compute or quote the figures with n and the overlap caveat, mark GBRR as unverified (or verify it), and update the MCP description.
- **Confidence:** high.

**F5. MEDIUM: Performance numbers lack the §7 labels**
- **Evidence:**
  - The signal table shows CAGR and Sharpe with "Tested 1000 days" but **no dates** (2022-09-28 → 2026-09-23, a bull window) and no "hypothetical, backtested" label.
  - The market table's "Sharpe (5y)" does not say rf = 0.
  - MCP `backtest_signal` and `get_prices` outputs carry **no disclaimer** and no window (`analyze_ticker` and `plan_trades` do).
- **Fix:** add "Hypothetical backtest, {start}–{end}, {costs} bp, cash 0%" to the signals note and to the `backtest_signal` output. Add `disclaimer` to every tool result.
- **Confidence:** high.

**F6. LOW/MEDIUM: Paper P&L accounting** (`app.js` 264, 273, 287, 293, 313)
- **Evidence:**
  - Realized P&L and avg cost exclude commissions. Replica: a round trip at an unchanged price shows **realized −$199.56, while cash actually fell $299.34**.
  - "since first trade" uses `pp.equity[0]`, but `equity` is truncated to 500 marks (about 8 h at 60-second refresh). After that, the baseline silently moves.
  - Stops and targets are checked only on 60-second polls while the Paper tab is visible. They fill at the quote (a correct gap-through) but without slippage.
  - Quotes from a `stale-cache` or `snapshot` source are used for fills with no label.
- **Fix:**
  - Include fees in avg cost and realized P&L.
  - Store `startValue` separately.
  - Apply the 10 bp slippage on stop fills.
  - Show the quote source in the paper tab.
- **Confidence:** high.

**F7. LOW: The shorts disclosure is off-surface**
- **Evidence:**
  - "Paper trading simulates long positions only" appears only in README Limits and Methods Limits. The Plan and Paper tabs say nothing, and the code silently `continue`s (app.js 274).
  - Mitigating: no plan generates shorts today. A long/short trend plan has 0 short orders, because with no evidence there is no negative tilt. So the "off = allow shorts" toggle currently has no visible effect on the plan, which is itself confusing.
- **Fix:** add a note by the toggle ("shorts appear only when a signal clears the evidence bar; they are not booked in paper trading") and log skipped short orders in Activity.
- **Confidence:** high.

**F8. LOW: Hygiene residue**
- **ERC solver:**
  - `ercWeights` returns no `{converged, iterations, residual}` and has no inverse-vol fallback (§5).
  - The ERC test covers one real 5-asset matrix, not random PD matrices. It is numerically fine: worst 0.21% on 200 random matrices.
- **Data:** `parseChart` throws when `quote.open` is missing.
- **Hit-rate test:** the binomial treats persistent-position days as IID. This is disclosed nowhere in the UI.
- **Copy:** the portfolio.js header comment is stale (`clamp(t/3)`). "A typical bad year" is labeled as a 1-in-20 loss, and "typical" contradicts that.
- **Fix:** return convergence metadata, add the random-PD property test, use `q.open?.[i]`, and reword.
- **Confidence:** high.

### §8 critic checklist (quant-research-hygiene)

| Box | Result | Evidence |
|---|---|---|
| Perturbation test passes | **PASS** | `test/engine.test.js` "NO LOOKAHEAD" passes, covering positions and strategy returns for every signal. The ewmaVol seed uses r[0..19] but is read only from t ≥ 19 (nil effect). |
| Hit rate vs base rate | **PASS** (caveat) | backtest.js 29–42 and 66. NVDA buy & hold p = 1.000; 0/44 grades have p < 0.05. Caveat: IID binomial on autocorrelated days (F8). |
| Beta-adjusted verdict | **PASS** (variant) | The benchmark is exposure-matched: `sr − expo·br` (for the same asset, β ≈ exposure). Cash earns 0%, as stated in Methods. The symmetric \|t\| > 3 verdicts all come out `none`. |
| Trials counted, hurdle applied | **PASS** (partial) | The HLZ t > 3 hurdle is applied symmetrically. Trials are counted in the copy ("0 of 44"), but the hurdle is not scaled by watchlist size, and there is no deflated Sharpe. |
| Solver convergence | **PARTIAL** | It converges (3e-14 in 20 sweeps; random PD worst 0.21%). No `{converged, iterations, residual}`, no fallback, no random-PD test (F8). |
| Partial bar excluded | **PASS** | Mocked in-session payload: the last bar is moved to `intraday`. The UI badge shows "intraday bar excluded". Not observed live (market closed). |
| Drift assumption disclosed | **PASS** | `DRIFT_SHRINK = 0`. Methods: "μ = 0 by default…". The symmetric bracket comes out ≈ 50/50, and a test covers it. |
| Calibration reported with n | **PARTIAL** | The UI tile shows "of {n} past forecasts". Methods notes the overlap. README/Methods quote a stale range (87–96% vs 86–98%). There is no sampling error and no effective n (F4). |

### Goal alignment (final)

| Goal | Status |
|---|---|
| G1 | MET. Distributions, not targets; paper trading only. |
| G2 | MET. LIVE/cache/stale-cache/snapshot labels; the intraday bar is excluded. |
| G3 | MET. |
| G4 | MET in the engine. The UI rationale overclaims (F3). |
| G5 | MET, but paper-trading correctness needs F1 and F2. |
| G6 | DELIVERED earlier. |
| G7 | Coordinator compliant. |

**What is fine:**
- no lookahead;
- honest "no reliable difference" verdicts;
- calibrated bands;
- caps and cash;
- sells before buys;
- the disclaimer in the header, README, Methods, tour end and plan_trades/analyze_ticker outputs;
- no "target price", "will" or "should buy" wording found. Routes use "target" only as a take-profit level next to P(target), P(stop) and P(neither), as §7 requires.

---
## Builder response to the final audit
| # | Status | Change |
|---|---|---|
| 1 | FIXED | The paper book is seeded from the side panel, and the panel is synced from the book after every execution or stop/target hit (`syncRailFromPaper`). Verified in the browser: the 2nd "Execute all" gives 0 orders, max weight 24.4% ≤ 25% cap, cash 4.5% ≥ 2% floor. |
| 2 | FIXED | Buys are limit orders: skipped (and logged) if the slipped quote is above the limit or at or below the stop. |
| 3 | FIXED | The plan note is conditional: when γ > 0 it says the risk shares are no longer equal. |
| 4 | FIXED | Calibration is stated as "about 86–98%, effective n ≈ 47, about ±4 pts". Griveau-Billion is marked "not independently verified". The MCP `backtest_signal` description mentions exposure matching and the base rate. |
| 5 | FIXED | The signal note says "Hypothetical, backtested" and gives the window dates. Sharpe is labeled rf 0. MCP `get_prices`/`backtest_signal` return a disclaimer, `backtest_signal` returns its window. |
| 6 | FIXED (partly) | Average cost and realized P&L include fees, and the P&L baseline is fixed (`startValue`). Paper tiles show the price source. Stops are still checked on refresh only; the log says gaps can pass the level. |
| 7 | FIXED | The Plan tab discloses shorts when shorting is allowed. Short orders in paper are logged as SKIP with the reason. |
| 8 | PARTIAL | The bad-year label is now "1-in-20", and the portfolio header comment is fixed. Solver convergence info and random-PD tests are deferred. |
Tests: 18/18.

## Portfolio features audit (2026-09-24, coordinator run 3)

Scope: holdings import (engine/holdings-import.js, web/samples), classify/exposure/position-risk, engine/tools.js new tools, server/search.js, server/chat.js, server/http.js (/api/search, /api/profile, /api/market, /api/chat), server/data.js, test/portfolio.test.js and test/chat.test.js.
Method: read all the code; `npm test` (TRL_OFFLINE=1); one-off `node` probes (scratchpad, not committed); a TRL_OFFLINE=1 server on PORT=4199, started and stopped (4173/4174 untouched); 3 web searches and 3 fetches for broker layouts. No Claude API calls. No product code edited.

### Goal alignment
| Ask (verbatim fragment) | Delivered | Status |
|---|---|---|
| "Upload a CSV from a broker (Schwab, Fidelity, Robinhood)" | importer.js + holdings-import.js + 3 samples | MET, with gaps F5 and F6 |
| "Type 'Tesla' and get TSLA, with a short company card" | /api/search, /api/profile, search_symbols tool | MET online only. Offline (TRL_OFFLINE=1) `/api/search?q=Tesla` returns `[]` because TSLA isn't in the snapshot, so a demo in offline mode can't show the headline example |
| "How much is in tech, in bonds and gold, and how concentrated the risk is" | exposure.js | MET, with gaps F3, F4 and F7 |
| "A chat box … 'Should I be worried about my NVDA position?' … real numbers … never as advice" | chat.js (Claude loop + offline router) | Engine MET. **No chat UI in web/ yet** (no caller of /api/chat; the builder is mid-edit). Honesty gap F1 |
| "portfolio graph + current stock exchange trends on the homepage" | web/home.js + /api/market | Present. Notes: /api/market uses range 3mo, so its TTL is 15 min, but data.js:14 says market trends refresh every minute. ^TNX "today" is shown as the % change of the yield, not in basis points |

### Findings (ranked)

**F1 · HIGH · The offline chat states things that don't come from the numbers.** The request was: "The answer comes from real numbers."
- Evidence: chat.js:134 always prints "None of the trading signals shows a reliable edge on ${sym}". It never reads `r.signals`. That happens to be true for NVDA today (4/4 verdicts are "No reliable difference", t from −1.43 to 0.33), but it is hard-coded. chat.js:155 always adds "(close to a coin flip)", whatever `probUp` is. chat.js:143 says "It behaves like N equal-sized holdings" (see F7).
- Fix: build the signals line from `r.signals` (list any verdict that isn't "no reliable difference"). Print "coin flip" only when |probUp − 0.5| < 0.05. Add a test that feeds a stubbed tool result with a passing signal and checks that the reply changes. Confidence: high.

**F2 · HIGH · Privacy promise vs chat data flow, and an exposed paid endpoint.**
- Evidence: importer.js:1 and index.html:65 promise that the file never leaves the device and no orders leave the browser. But chat.js:63 puts holdings, share counts, cash and the watchlist into the user turn. That goes to this server and, when a key is set, to Anthropic. Nothing in web/ discloses it. The chat UI doesn't exist yet, so this is the moment to add the disclosure. Separately, `listen(PORT)` has no host, so it binds every interface (`lsof` showed `TCP *:4199`). /api/chat has no auth and no rate limit. With ANTHROPIC_API_KEY set, anyone on the LAN can spend the key's credits.
- Fix: put a line under the chat box: "To answer, the chat sends your tickers, share counts and cash to this app's server, and to Anthropic's Claude API when Claude mode is on. The CSV file itself is never uploaded." Default to `listen(PORT, "127.0.0.1")`, with an env override. Confidence: high.

**F3 · MED · The sector-concentration flag produces nonsense for non-equity funds.**
- Evidence: exposure.js:62 picks `topSector` from *all* rows whose sector name doesn't match `/ETF|fund|Treasur|bond|Gold|REIT/`. The denominator counts only equity rows. So "T-bills" (BIL), "Silver", "Oil", "Broad commodities", "Inflation-protected", "Crypto", "Unclassified" and "Unknown sector" all count as stock sectors. Reproduced (BIL + SLV + AAPL): *"T-bills stocks and sector funds are 4775% of your stock holdings."*
- Fix: group sectors over rows with `/equity/i.test(assetClass)` only, and exclude "Unknown sector". Add a test with a T-bill fund. Confidence: high.

**F4 · MED · Fund-name keywords misclassify popular funds.**
- Evidence: classify.js:42–47 checks the bond regex first, and it includes bare `income`. It also uses unanchored `gold` and `ether`. Probes: JEPI "JPMorgan Equity Premium Income ETF" → **Bonds**. GSLC "Goldman Sachs ActiveBeta U.S. Large Cap Equity ETF" → **Gold & commodities**. EWN "iShares MSCI Netherlands ETF" → **Crypto**. The ETF-by-category design is fine and disclosed. These are regex bugs.
- Fix: use word boundaries (`\bgold\b`, `\bether(eum)?\b`). Test the equity/international regexes before `income`, or drop `income` unless `bond|fixed` is also present. Add JEPI, SCHD, VIG, VYM, BIL, SGOV and FXAIX to the map. Confidence: high.

**F5 · MED · Positions disappear from the numbers without notice (shorts, Robinhood date windows).**
- Evidence: exposure.js:16–17 keeps `shares > 0` and reports `missing` only for positions without bars. A short (import warns, holdings-import.js:132) is in neither list. Probe: AAPL 10 + NVDA −50 → only AAPL, flagged "100% of the portfolio", no note. Robinhood activity reports cover a date range the user picks. A sell of shares bought before that range yields a negative position (probe: NVDA −30) with no warning. Option trades (BTO/STC/OEXP) are silently ignored. `costMap` (holdings-import.js:94–104) is computed and never used.
- Fix: warn on the import "Sold more NVDA than bought in this file. The report probably starts after you bought. Export activity from account opening." Have exposure() list excluded non-positive positions. Warn when option codes are present. Remove or use costMap. Confidence: high.

**F6 · MED · Broker-format coverage gaps (checked against public descriptions).**
- Money-market funds without `**` are imported as stock. Schwab SWVXX or a non-core Fidelity FDRXX becomes 5,000 "shares", has no price data, and is excluded, so cash is undercounted by $5,000 (probe).
- Share classes: Schwab's "BRK/B" is skipped as "not a ticker". Fidelity's "BRK.B" is kept, but Yahoo needs "BRK-B", so it ends up in `missing`.
- Current Fidelity layout: per the OpenBB issue below, Fidelity merged "Account Name / Number" and renamed columns in 2025–26. It parses correctly (cost via "total cost basis") but is labeled "Generic CSV". The sample uses the old layout.
- `num("$ (1,000.00)")` → +1000 (the paren test is anchored at the start) and `num("-")` → 0 (should be null).
- Fix: detect money market by the Security Type/Type column ("Money Market") or a description matching /money market|cash reserves|money (inv|fund)/. Map `[./]` → `-` before the data fetch. Add Fidelity detection on "account name / number". Handle the parens after stripping the `$`. Confidence: med-high.

**F7 · LOW-MED · Concentration wording overclaims.**
- Evidence: exposure.js:68 says "The portfolio *behaves like* 2.9 equally sized positions". That is 1/HHI of dollar weights, excluding cash, and it ignores correlation (VOO + SPY + QQQ count as 3). Top-1 and top-3 use total including cash, while HHI uses invested only, and neither is labeled. "drives 86% of the portfolio's day-to-day risk" is actually the share of *recent EWMA variance*.
- Fix: "Your invested money is spread like 2.9 equal-sized positions (by value; it doesn't account for holdings that move together)." "…accounts for 86% of the portfolio's recent volatility (variance share, EWMA)." Apply the same fix in chat.js:143. Confidence: high.

**F8 · LOW · Claude loop edge cases and input validation.**
- API conventions are correct (see Verified OK).
- Gaps: `stop_reason` of `max_tokens`, `model_context_window_exceeded` or `pause_turn` is returned as a normal (possibly empty or truncated) reply with no flag (chat.js:79–82).
- /api/chat doesn't validate the portfolio. `cash:"abc"` makes the weight null (NaN), and it prints in the reply. Holdings keys are inserted into the prompt unvalidated.
- The offline symbol finder takes any uppercase word, so "ETF" is treated as a ticker ("No price data for ETF").
- Prompt injection: the holdings context in the user turn is acceptable. Everything in it is user-supplied anyway, the tools are read-only and bound server-side to the same portfolio, and there is no cross-user data. The residual risk is indirect injection via Yahoo names or descriptions in tool results, which is low with read-only tools.
- Fix: coerce `cash`/shares to finite ≥ 0 numbers. Filter keys with data.js's SYMBOL regex. Return `{truncated:true}` plus a notice on non-terminal stop reasons. Optionally, move the app context into a mid-conversation `role:"system"` message (supported on claude-opus-5). Use a stop-word list or a known-ticker check in findSymbol. Confidence: med.

### Verified OK (reproduced)
- `npm test` (TRL_OFFLINE=1): **33/33 pass**.
- Risk share = w_i(Σw)_i/σ² is the correct Euler decomposition. A finite-difference check of ∂σ²/∂w_i · w_i/σ² gives exactly 2× each share (NVDA 1.7225 vs 0.8612 …), and the shares sum to 0.9999. The covariance is EWMA λ 0.94 annualized ×252 (portfolio.js:49), so annualVol is correctly labeled. Cash at zero vol is handled by including cash in the weights.
- HHI = Σ(value_i/invested)² matches the test. 1/HHI is a correct "effective N" *of value weights* (wording only, F7).
- probLossOver10pct histogram interpolation is sound (linear within a bin; the last bin contains the max). Against an exact count on the same seed: NVDA 0.1653 vs 0.159, TLT 0.0027 vs 0.0025, SPY 0.0081 vs 0.0080. Error is under one bin (optional: count `terminal` directly in forecast()).
- Parser: RFC-4180 quotes, escaped quotes, CRLF and BOM. Fractional shares (0.5432, 8.5). Multi-account merge (Fidelity GOOGL 40 + 10; a Schwab multi-section export with repeated headers and per-account "Account Total" rows gives AAPL 15). Options skipped (Schwab by regex; the Fidelity " -AAPL270115C350" form is skipped, with the reason "not a ticker"). Footer/disclaimer rows skipped. SPAXX** and "Pending Activity" go to cash.
- Layouts: the Schwab sample matches the public descriptions (a "Positions for account …" preamble, "Qty (Quantity)", "Mkt Val (Market Value)"). The Fidelity sample matches the *old* documented header set. Robinhood columns (Activity Date, Process Date, Settle Date, Instrument, Description, Trans Code, Quantity, Price, Amount) and option codes BTO/STC/OEXP match third-party guides. No primary Robinhood document was found, so they stay UNVERIFIED against Robinhood itself.
- Claude API loop against the conventions: model `claude-opus-5`, `betas:["server-side-fallback-2026-07-01"]` with `fallbacks:"default"` (the correct header for the scalar form), `output_config:{effort:"medium"}`, and `client.beta.messages.create` (SDK 0.128.0 types include `fallbacks`). `refusal` is checked before content is read. `response.content` is echoed back whole, so thinking blocks are preserved. All tool_results go in one user message with `is_error` on failure. max_tokens 16000 on a non-streaming request is fine. Auth errors fall back to offline with a notice.
- The honesty system prompt covers tool-only numbers, no buy/sell/hold/"should", distributions with a horizon, snapshot/stale disclosure, the "can't tell you whether to worry" opener and "Not investment advice." Offline replies pass the BANNED regex and show the snapshot notice.
- data.js: TRL_OFFLINE=1 skips both the network and the disk cache (snapshot only, labeled). Stale disk cache is labeled "stale-cache". A partial daily bar is split off as `intraday`.
- search.js: the offline fallback is labeled `source:"offline"`. Only live results are cached. Non-tradable types (futures) are filtered (tested).

Sources (broker layouts): Fidelity old vs current headers: https://github.com/prajoria/OpenBB/issues/1753 ; Fidelity example: https://github.com/gerardrbentley/fidelity-account-overview/blob/main/example.csv ; Schwab export steps: https://help.wingmantracker.com/article/3178-charles-schwab-positions-csv-instructions (procedure only, no column list) ; Robinhood activity report: https://robinhood.com/us/en/support/articles/finding-your-reports-and-statements/ and https://bullbenchmark.com/blog/robinhood-export-guide (third-party). The exact Schwab column names are UNVERIFIED against a primary Schwab document (search-summary level only).

---
## Builder response to the portfolio-features audit
| # | Status | Change |
|---|---|---|
| 1 | FIXED | Offline chat: `signalLine()` builds the signal sentence from the graded results, and `probUpPhrase()` says "coin flip" only when P(up) is within 7 points of 50%. Tests cover both. |
| 2 | FIXED | A privacy line under the chat box says what gets sent (question, tickers, shares, cash) and where (this server, plus Anthropic in Claude mode). The server binds to 127.0.0.1 by default (`HOST` env to override). |
| 3 | FIXED | The sector flag counts only stock sectors (equity asset class, excluding broad/index ETFs). Test: a BIL+SLV+AAPL book no longer produces "4775%". |
| 4 | FIXED | Fund-name keywords use whole words, most specific first, with equity-income checked before bonds. 20+ common funds added to the known list (JEPI, SCHD, VT, SGOV…). Tests cover Goldman / Netherlands / Equity Premium Income. |
| 5 | FIXED | Negative Robinhood positions are left out with a warning. Option rows are counted and reported. Short positions are listed as excluded in the exposure flags. |
| 6 | FIXED | Money-market tickers (SWVXX, FDRXX…) and descriptions count as cash. BRK/B, BRK.B and "BRK B" become BRK-B. The new Fidelity header (a single "Account" column) is detected. "$ (1,000.00)" parses as −1000. Snapshot now includes TSLA, VOO and BRK-B, so the samples and the "Tesla" example work offline. |
| 7 | FIXED | Wording: "accounts for X% of recent volatility (its share of variance)" and "by dollar weights alone, as concentrated as N equal positions". |
| 8 | FIXED | `sanitizePortfolio()` validates tickers, shares, cash and the watchlist; messages are capped at 2,000 characters. A reply cut off at `max_tokens` is labeled. Offline ticker detection ignores common words (ETF, USD, CEO…). |
| cov. | FIXED | Market panel: the 3-month range now refreshes every 60 s, matching the comment. The 10-year yield shows its daily move in basis points. |
Tests: 40/40.
