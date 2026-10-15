# PLAN: TradeRoute Lab

## 1. Frame
- **Problem.** Retail trading tools show confident arrows ("BUY, target $X") with no
  uncertainty, no out-of-sample evidence and no link to the user's risk budget.
- **Hypothesis.** A tool that (a) shows forecasts as *distributions*, (b) grades every
  signal with a walk-forward backtest and a skill test, and (c) turns the user's
  preferences into sized, stop-protected trade routes will give *better-calibrated*
  decisions than point predictions do.
- **Falsifier.** If forecast intervals are badly calibrated on held-out data (e.g. a
  90% band covers far from 90%), or if the backtest shows lookahead, the tool is misleading.
- **Non-goals.** Real order execution, intraday data, options, tax lots, advice.

## 2. Evidence that shapes the design (verification: coordination/SOURCES.md)
| Design choice | Why |
|---|---|
| Forecast = distribution, drift shrunk to ~0 | Markets are close to efficient (Fama 1970). Return predictors mostly fail out of sample (Welch & Goyal 2008). |
| Signals limited to momentum / trend / mean-reversion, each graded | Momentum has the strongest published record (Jegadeesh & Titman 1993; Moskowitz, Ooi & Pedersen 2012) but crashes (Barroso & Santa-Clara 2015) |
| Skill test with a multiple-testing hurdle (t > 3) | Backtest overfitting (Bailey et al. 2014), factor zoo (Harvey, Liu & Zhu 2016) |
| EWMA volatility λ = 0.94; volatility targeting | RiskMetrics (1996); volatility-managed portfolios (Moreira & Muir 2017) |
| Position sizing capped well below Kelly | Kelly (1956). Full Kelly is too aggressive under parameter uncertainty. |

## 3. Architecture
```
engine/ (pure ESM, zero deps, runs in browser + Node + MCP + tests)
  stats.js      returns, vol, Sharpe/Sortino, drawdown, beta, correlation, EWMA, ATR, RSI, SMA
  forecast.js   filtered historical simulation (bootstrap of vol-standardized returns × current EWMA vol)
  signals.js    momentum / trend / mean-reversion → position in [-1, 1]
  backtest.js   walk-forward, 1-day execution lag, costs, hit rate + binomial test, t-stat vs hurdle
  portfolio.js  preferences → risk-parity base + evidence-weighted tilt → target-vol scaling
  routes.js     holdings → target: ordered orders, ATR stop/target, Monte-Carlo P(target before stop)
server/data.js  Yahoo v8 chart API (unofficial), 15-min cache, real snapshot fallback
server/http.js  static web + /api/history, /api/quotes
server/mcp.js   agent tools
web/            preferences layer, market table, ticker lab, plan & routes, paper trading, tour
```

## 4. Milestones
| M | Slice | Exit criterion |
|---|---|---|
| M1 | Data: live fetch + snapshot fallback | `/api/history?symbol=AAPL` returns ≥ 1,000 bars, live or snapshot, labeled |
| M2 | Engine: stats, forecast, signals, backtest | Tests: known-answer stats, **no-lookahead test**, forecast calibration on held-out data |
| M3 | Plan & routes | Tests: weights ≤ caps, cash ≥ 0, sells before buys, symmetric route ≈ 50% |
| M4 | Web: interactive layer + paper trading | Changing preferences re-plans instantly; no page errors |
| M5 | MCP + demo | SDK client test; `npm run demo` opens the guided tour |

## 5. Premortem
1. *Users read the forecasts as promises.* Show fan charts and probabilities only, never a single "target".
2. *The backtest looks great because of lookahead.* Keep a 1-bar execution lag, add a test that perturbs future data, and require out-of-sample checks.
3. *The API breaks mid-demo.* Keep a real snapshot fallback with a visible LIVE/SNAPSHOT badge.
4. *It overfits by trying many signals.* Count the trials, apply the t > 3 hurdle, and show "no evidence of skill" plainly.
5. *It gets read as advice.* Frame it as education and simulation, use paper trading only, and show a disclaimer on every surface.
