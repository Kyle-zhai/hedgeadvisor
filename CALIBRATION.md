# Calibration backtest — are HedgeAdvisor's probabilities honest?

The estimate features (de-vig, ensemble, cross-market joint) only earn trust if their numbers
are **calibrated**: of the things we call 40%, ~40% should happen. This is the honest gate —
we measure it against REAL resolved Polymarket outcomes instead of asserting accuracy.

- Metrics: `lib/estimate/calibration.ts` (Brier, log-loss, calibration-in-the-large/bias, ECE,
  Brier skill, reliability buckets) — pure, unit-tested in `test/calibration.test.ts`.
- Harness: `test/backtest-calibration.test.ts` (skipped by default; un-skip + run to reproduce).
  It pulls resolved markets via Gamma `closed=true`, reads each token's price ~7 days before
  resolution via CLOB `/prices-history`, and scores the forecast against the realized outcome.

## Results (run 2026-06-17, top-volume resolved events)

### 1. Marginal calibration — are de-vigged YES prices (~7d out) calibrated? **YES.**
n=120 · **Brier 0.013** · log-loss 0.055 · **ECE 0.032** · Brier-skill **0.60** · bias +0.022 · base-rate 0.033

Reliability (pred → actual): 0.0–0.1→0.00 (n=104) · 0.4–0.5→0.50 · 0.5–0.6→0.50 · 0.6–0.7→1.00 · 0.8–0.9→1.00.
Low ECE (~3%) and Brier-skill 0.60 (beats the base-rate guess): **Polymarket prices are a well-calibrated
marginal input.** Caveat: this top-volume sample is longshot-heavy (base rate 3.3%; most mass in 0–0.1), and
the mid/high buckets are thin (n=1–2), so the high end is illustrative, not robustly estimated. Slight (+2%)
over-forecasting bias on small-n low buckets.

### 2. De-vig method comparison — does Shin/power beat proportional? **Not measurably.**
8 multi-outcome events, n=159 outcomes:
| method | Brier | log-loss | ECE |
|---|---|---|---|
| proportional | 0.0236 | 0.0889 | 0.0151 |
| power | 0.0236 | 0.0889 | 0.0152 |
| shin | 0.0237 | 0.0888 | 0.0152 |

The three are identical to ~4 decimals. **Honest conclusion:** on real resolved markets the de-vig method
choice makes no measurable calibration difference (the overround on liquid markets is small, so all three
recover nearly the same q). The Shin/power upgrade is justified as *robustness on skewed/high-overround books*
(exact-score grids, thin partitions) and as a *transparency feature* (we show the method + recovered z/k), **not**
as an accuracy gain. We keep `devigDetailed` (Shin→power→proportional) but do not claim it predicts better.

### 3. Cross-market joint — is independence the right center? **Plausibly, but undetermined.**
15 random cross-event pairs: mean independence P(both)=0.105 vs realized P(both)=0.133. Realized is mildly
higher, hinting at slight positive co-movement, but n=15 is far too small to distinguish from noise. This
supports the design: we do **not** assert a correlation coefficient — we show independence + the exact Fréchet
envelope (the honest range) and a clearly-labelled illustrative ρ. The (noisy) realized>independence is
directionally consistent with the illustrative ρ=0.25 being a reasonable, non-misleading midpoint.

## Takeaways for the product
- De-vigged market prices are a trustworthy, well-calibrated marginal — good foundation.
- Don't oversell the de-vig method: keep it for robustness/transparency, not as an accuracy claim (backtest says so).
- Keep the cross-market joint honest (range, not a point); a bigger labelled-pairs study is needed before any ρ
  is presented as more than illustrative.
- Re-run this backtest periodically (or after de-vig changes) — it's the empirical check on the honesty claims.
