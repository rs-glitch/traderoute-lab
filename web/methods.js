// Methods note (scientific-communication): finding first, then data, model, validation, limits, sources.
// Citations verified by the coordinator's researcher (coordination/SOURCES.md).

export const methodsHtml = () => `
<h1 style="margin-top:0">Methods</h1>
<p class="note"><b>Finding first.</b> On five years of daily data for the default watchlist, the forecast bands are
<b>reasonably calibrated</b>: 90% bands contained about 86–98% of realized prices at ~99 past origins per ticker. The origins overlap (effective n ≈ 47), so each figure carries roughly ±4 points of sampling error. The classic trading signals
(momentum, trend, mean reversion) <b>don't clear</b> an honest skill test against an exposure-matched buy &amp; hold.
That is consistent with the efficient-markets and backtest-overfitting literature. So the tool sizes risk rather than
predicting direction. <b>Education &amp; simulation only, not investment advice.</b></p>

<h2>Data</h2>
<p>Daily OHLCV from the Yahoo Finance v8 chart endpoint (unofficial, no key, no service guarantee). Prices are
back-adjusted for splits and dividends. Results are cached for 15 minutes, and a real snapshot is used when
offline. The header badge shows <b>LIVE</b> or <b>SNAPSHOT</b> plus the as-of date. During market hours, today's
unfinished bar is <b>excluded</b> from all signals and statistics. The default watchlist is today's large, liquid
names, which is a <b>selection bias</b>: historical returns look better than a random stock's would have.</p>

<h2>Forecast: filtered historical simulation</h2>
<pre class="mono sub" style="white-space:pre-wrap">σ²ₜ = λσ²ₜ₋₁ + (1−λ) r²ₜ,  λ = 0.94          (RiskMetrics EWMA)
zₜ = (rₜ − r̄) / σₜ₋₁ ,  then re-centered to mean 0
simulate: r* = μ + σ z*,  z* drawn from {zₜ},  σ updated by the same recursion
μ = 0 by default (an asset's own past mean is a poor predictor, and the watchlist is hindsight-selected)</pre>
<p>This gives 2,000 paths per ticker, from which we take quantiles (5/25/50/75/95), P(up), VaR and CVaR.
<b>Calibration check:</b> at rolling origins using only data available then, does the realized price land inside
the 90% band? Origins overlap, so the coverage figures are approximate.</p>

<h2>Signals and the skill test</h2>
<ul>
<li>Fixed, literature-default parameters, with no fitting:
  <ul>
    <li>time-series momentum 12-1 (Moskowitz, Ooi &amp; Pedersen 2012)</li>
    <li>50/200-day trend</li>
    <li>RSI(14) 30/70 mean reversion</li>
  </ul></li>
<li><b>Timing:</b> the signal at close t is traded at close t+1 and earns from t+1 to t+2. A test confirms that
  perturbing future prices never changes past results.</li>
<li><b>Benchmark:</b> buy &amp; hold scaled to the signal's own average exposure, with cash at 0%. This separates
  "was out of a bull market" from "picked bad days".</li>
<li><b>Evidence bar:</b> the t-statistic of daily excess returns has to reach |t| &gt; 3 (Harvey, Liu &amp; Zhu
  2016), and the bar is the same for better and worse. We look at many signals on many tickers, and backtest
  overfitting is easy (Bailey, Borwein, López de Prado &amp; Zhu 2014).</li>
<li><b>Hit rate:</b> tested against the base rate of up days, not 50%, because a long-only position is "right" on
  every up day.</li>
</ul>

<h2>Plan: from preferences to a portfolio</h2>
<ol>
<li><b>Base:</b> equal risk contribution from an EWMA covariance, solved by cyclical coordinate descent.</li>
<li><b>Tilt:</b> × (1 + 1.5 · signal · evidence). Evidence is 0 below t = 2 and 1 at t ≥ 3, so without evidence
  there is no tilt.</li>
<li><b>Scale</b> to the target volatility of the risk profile (5–22%) without leverage. If a diversified
  portfolio falls short, weight toward higher-volatility names; if the caps still bind, say so.</li>
<li><b>Caps:</b> anything above the per-position cap stays in cash.</li>
</ol>
<p>Volatility management follows Moreira &amp; Muir (2017). Momentum's crash risk is covered by Barroso &amp;
Santa-Clara (2015) and Daniel &amp; Moskowitz (2016).</p>

<h2>Trade routes</h2>
<p>Orders run sells first, then buys; cash never goes negative, and shares are whole. Each opening order carries:</p>
<ul>
<li>a limit at last price ± 10 bp</li>
<li>a stop at entry − k·ATR(14), with k from 1.5 to 3.5 by risk profile</li>
<li>a target at 1.5× the stop distance</li>
<li>a size capped so a stop-out loses ≤ 1–2.5% of the portfolio (a fixed-fractional, well-below-Kelly rule; Kelly 1956)</li>
</ul>
<p>We simulate the horizon with the same model and report three probabilities side by side: <b>target first,
stop first, neither</b>. With zero drift and a 1.5:1 target, "stop first" should usually be more likely. That's
the honest price of a better payoff.</p>

<h2>Limits</h2>
<ul>
<li>Daily bars only.</li>
<li>Stops are checked on closes; real stops can gap.</li>
<li>No taxes, borrow costs or dividend timing.</li>
<li>Five years is one market regime.</li>
<li>Paper trading marks to the latest quote and simulates long positions only.</li>
</ul>

<h2>Sources</h2>
<ul class="sub">
<li>Fama, E. (1970). Efficient Capital Markets: A Review of Theory and Empirical Work. <i>J. Finance</i> 25(2).</li>
<li>Jegadeesh, N. &amp; Titman, S. (1993). Returns to Buying Winners and Selling Losers. <i>J. Finance</i> 48(1).</li>
<li>Moskowitz, T., Ooi, Y. H. &amp; Pedersen, L. H. (2012). Time series momentum. <i>J. Financial Economics</i> 104(2).</li>
<li>Welch, I. &amp; Goyal, A. (2008). A Comprehensive Look at the Empirical Performance of Equity Premium Prediction. <i>Rev. Financial Studies</i> 21(4).</li>
<li>Harvey, C., Liu, Y. &amp; Zhu, H. (2016). …and the Cross-Section of Expected Returns. <i>Rev. Financial Studies</i> 29(1).</li>
<li>Bailey, D., Borwein, J., López de Prado, M. &amp; Zhu, Q. (2014). Pseudo-Mathematics and Financial Charlatanism. <i>Notices of the AMS</i> 61(5).</li>
<li>Moreira, A. &amp; Muir, T. (2017). Volatility-Managed Portfolios. <i>J. Finance</i> 72(4).</li>
<li>Barroso, P. &amp; Santa-Clara, P. (2015). Momentum has its moments. <i>J. Financial Economics</i> 116(1).</li>
<li>Daniel, K. &amp; Moskowitz, T. (2016). Momentum crashes. <i>J. Financial Economics</i> 122(2).</li>
<li>J.P. Morgan/Reuters (1996). RiskMetrics Technical Document, 4th ed.</li>
<li>Kelly, J. L. (1956). A New Interpretation of Information Rate. <i>Bell System Technical Journal</i> 35(4).</li>
<li>Griveau-Billion, T., Richard, J.-C. &amp; Roncalli, T. (2013). A Fast Algorithm for Computing High-Dimensional Risk Parity Portfolios. SSRN. <i>(Algorithm reference; not independently verified by the coordinator.)</i></li>
</ul>`;
