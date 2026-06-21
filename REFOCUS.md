# REFOCUS — the north star: conditional loss-minimization, not prediction

> **Thesis (encode this everywhere).**
> This product does **not** predict whether your bet wins. It answers one question:
> **"If your bet does NOT win, how little can you lose?"**
> 这个产品不预测你会不会赢；它回答的是：**如果你这注没中，怎么把亏损压到最小。**

Status: **plan only — no code changed.** Owner clarified the north star on 2026-06-17; this is the
agreed refocus backlog. Every file:line below was verified against the current tree.

---

## 0. The objective, formally

The user holds (or is about to place) a **primary bet B** that pays in a set of states `W` (the
"B-wins" states) and loses in every other state. The product chooses hedge positions to **minimize
the loss across the B-fails states (`Ω \ W`)**.

The decision-relevant quantities are **pure arithmetic over payoffs × executable prices — no
win-probability required**:

| Quantity | Definition | Needs P(win)? |
|---|---|---|
| **Worst-case net loss** | `max(0, −min over ALL states of PnL)` | **No** |
| **Loss if primary fails** | `max(0, −min over states ∉ W of PnL)` | **No** |
| **Cost of protection** | `PnL_in_win(before) − PnL_in_win(after)` (upside forgone = the premium) | **No** |
| **Cost-vs-protection frontier** | the set of `(cost, loss-if-fails, worst-floor)` over all postures | **No** |
| EV, P(profit), P(all hit), CVaR | probability-weighted | **Yes → secondary context only** |

The honesty backbone is unchanged and **non-negotiable**: EV always shown negative, no phantom gain,
exact-vs-estimated labeled, "probabilities are market-implied (de-vigged), not forecasts."

### 0.1 The owner's hard constraint (2026-06-17 refinement) — and what it implies

The objective was sharpened with one HARD, probability-free constraint plus a scope widening:

- **Cross-category hedging is in scope.** Hedge legs may come from OTHER markets / OTHER bet types,
  chosen by a LOGICAL/structural relation to B — not limited to B's own market — precisely because we
  do **not** commit to precise probabilities (so we lean on logic/structure, not fitted correlation).
- **Win-floor constraint (new, hard, owner chose the keep-a-share variant): if B WINS, the user must
  still keep at least a fraction `k` of the winnings.** Let `G = s_B·(1−p_B)/p_B` be B's profit if it
  wins with no hedge. The hedge premium may eat into the winnings but the net must stay `≥ k·G` in every
  B-wins state. `k ∈ [0, 1)` is the posture knob (default **k = 0.5**, "keep at least half your winnings").
  `k = 0` is the break-even variant; the owner picked `k > 0`.

Together these make the product a clean **maximin LP over per-state payoffs — no win-probability anywhere**:

```
choose hedge legs h_j and shares x_j ≥ 0 to
  MAXIMIZE    min over B-FAILS states ω of  PnL(ω)      # = minimize the worst-case loss if B fails
  SUBJECT TO  PnL(ω) ≥ k·G  for every B-WINS state ω    # winning keeps at least k of its profit
              x_j ≥ 0,  Σ x_j·price_j ≤ (1−k)·G         # spend at most (1−k) of the winnings on insurance
```

Every `PnL(ω)` is deterministic given the state (the `paysIn`/payoff matrix already exists in
`lib/netcost/benefit.ts:21-34`). No forecast is used.

**Corollary — the hedge budget is `(1−k)` of your winnings.** When hedge legs pay nothing in the B-wins
states (the usual case), the win-floor collapses to a single number:

```
total hedge cost  ≤  (1 − k) · G  =  (1 − k) · s_B · (1 − p_B) / p_B
```

For a $10 longshot at 25¢ (`G = $30`): at the default `k=0.5` you may spend up to **$15** on protection;
at `k=0` up to **$30**. For a $10 favorite at 80¢ (`G = $2.50`): only **$1.25** at `k=0.5`. **Protection
capacity scales with the odds AND the posture — all from prices, not forecasts.** Both `s_B` and `p_B`
are already in hand (`decide.ts:100` position; `buildPlan.ts:110-111`).

**The slider is BIPOLAR, centered on "no hedge" (owner's model, 2026-06-17).** One signed axis
`t ∈ [−1, +1]`; the user's bet B sits untouched at the CENTER. This replaces the abstract `s∈[0.4,1]`
slider and Kelly entirely:

- `t = 0` — **MIDDLE = no hedge**: hold B alone. Win → `+G`, fail → `−s_B`. The honest baseline.
- `t < 0` — **LEFT = protect**: add OFFSETTING legs (pay when B fails). Spend a fraction `f = |t|` of the
  winnings on protection → keep `(1−f)·G` if right, lose less if wrong. Far left (`t = −1`, `f = 1`):
  break-even if right, smallest possible loss if wrong ("极度保守"). **This half is the probability-free
  maximin LP + win-floor**, with the keep-fraction `k = 1 − f` (so `k·G = (1−|t|)·G`).
- `t > 0` — **RIGHT = amplify**: add REINFORCING legs (pay MORE when B wins) / more exposure → win more if
  right, lose more if wrong ("极端收益，风险也高"). Worst-case loss grows; **clearly labeled higher-risk,
  EV still negative, no fabricated correlation**. This half IS the combo/parlay (see §4).

The left/center is the product's rigorous, probability-free CORE and PURPOSE; the right is an optional,
loudly-labeled expression mode ("if you insist on more upside, here is the honest extra downside").

Example ($10 @ 25¢, `G = $30`; left hedged with B-NO ~78¢):

| slider `t` | meaning | keep if B wins | worst loss if B fails |
|---|---|---|---|
| −1.0 (max protect) | spend all winnings on protection | $0 | ≈ −$1.5 |
| −0.5 (**default handle**) | keep half your winnings | +$15 | ≈ −$5.8 |
| 0 (no hedge) | hold B alone | +$30 | −$10 |
| > 0 (amplify) | add correlated upside | **more** (depends on legs) | **worse** (≥ −$10) |

Right-side numbers are intentionally not fabricated — they depend on the specific reinforcing legs and are
shown live from real books. With vig (`p_B + p_NO > 1`) the loss-if-fails never reaches exactly $0 even at
`t = −1`; the LP returns the best feasible residual and the frontier shows that gap honestly — never a
"fully hedged for free." **Default handle opens LEFT-of-center at `f = 0.5`** (keep ≥ half your winnings) —
consistent with the loss-minimization purpose and the owner's keep-a-share choice; the user can drag to
center (no hedge) or right (amplify).

---

## 1. Already aligned — preserve verbatim (the spine is correct)

The core is **already a loss-minimization engine**. Do not weaken any of this:

- **Exact probability-free worst-case floor** — `lib/netcost/benefit.ts:68-69`
  (`minPnl = Math.min(...dist.map(d=>d.pnl)); maxLoss = Math.max(0, -minPnl)`). This **is** the
  north-star primitive and is already the lead stat on the Hedge page.
- **The NO_GO guards** — `lib/sizing/decide.ts:202-209`: never GO if the worst case gets worse, if
  cost ≥ max-loss removed, or if no risk is removed. Probability-free. The single most important
  invariant in the product.
- **The Hedge page hierarchy** — `app/page.tsx`: verdict-led headline, "Max loss before→after" as the
  FIRST stat, no win-probability headline, no +EV. **This is the reference pattern the other two
  surfaces must copy.**
- **De-vig q as the executable-price honesty floor** — `lib/pipeline.ts:769`, `buildPlan` fairValue/vig.
  Forces pay-price up to fair so a thin/stale book can't fabricate +EV. This is **compliance, not
  prediction** — survives 100%.
- **Real-book executable pricing** (slippage/fee/capacityHit, near-touch cap) — `lib/netcost/walk.ts`.
  The true cost of protection, never mid-price fiction.
- **Structural/analytic correlation** — `lib/correlation/structural.ts` (complement ρ=−1) and the
  price-monotonicity containment gate `lib/pipeline.ts:389-390`. Arithmetic, not forecasting.
- **"Don't bet / Don't bother" as first-class verdicts** — `decide.ts:120-153`, `buildPlan.ts:151,313`;
  guaranteed-loss guard `buildPlan.ts:292-295`.
- **The combo structural detector** — `lib/combo/structuralJoint.ts`: exact same-outcome YES/NO,
  mutual-exclusivity, subset/containment with ANALYTIC provenance. **The seed of the hedge-discovery
  engine** (see §4).
- **The express↔min-variance blend** — `lib/plan/allocate.ts`: verified probability-free (blends on
  **prices**, not q). This already **is** a cost-vs-protection frontier parameterization.

---

## 2. Where it drifts toward prediction (concentrated, cheap)

1. **`/plan` and `/combo` lead with win-probability / payout.**
   - `app/plan/page.tsx:300-301` "Chance of profit" (pProfit) as a headline stat; `:309` "Best case"
     (max gain) at equal weight.
   - `app/combo/page.tsx:143` "Chance all hit", `:147` "Payout if all hit" as the first stats.
   - These are a betting/prediction frame. **Keep the numbers** (honesty), but demote them to a muted
     "market-implied context, not a forecast" sub-row.
2. **The pass/fail bar rides on a probability-weighted basis.** `lib/sizing/decide.ts:86` defaults
   `basis = "cvar"` (q-weighted tail) — should be the probability-free floor `"maxLoss"`.
3. **`/combo` is structurally anti-hedge today.** `lib/combo/combo.ts:108` hardcodes
   `maxLossUsd = −stakeUsd` and `:124` keys the verdict on `comboProb < 0.1` — a parlay maximizes
   correlated upside, the opposite of a hedge.
4. **Kelly is the sole size recommendation** (`lib/sizing/strategy.ts`, `lib/sizing/kelly.ts`):
   q-weighted growth presented as THE answer. Two users with identical payoffs+prices but different q
   get different recommended sizes.
5. **PRODUCT.md never states the thesis** — the documented root cause of the downstream UI drift.

---

## 3. Two metrics + one frontier the product is MISSING (pure arithmetic, no new probabilities)

- **`lossIfPrimaryFails(dist, winIdx)`** in `lib/netcost/benefit.ts`:
  `max(0, −min_{i ∉ winIdx} dist[i].pnl)`. The literal north-star number. Thread `winIdx` (the B-wins
  state indices, reuse the `paysIn` sets already in the pipeline) through `decide.ts` and `buildPlan.ts`;
  surface as **THE headline stat** on `/` and `/plan`.
- **`costOfProtection`**: `PnL_in_win(before) − PnL_in_win(after)` (worst B-win state if W has several).
  Distinct from `execFriction` and from the expected vig. Pair it with loss-if-fails as the two axes.
- **Materialized cost-vs-protection frontier**: `lib/sizing/strategy.ts` already evaluates a 200-step
  grid (`strategy.ts:59`) and discards all but the Kelly argmax. Emit the full set of
  `(costOfProtection, lossIfPrimaryFails, worstFloor)` points instead; render on `/plan` wired to the
  Express↔Protect slider (`allocate.ts` proves the frontier is drivable on prices, not q).

---

## 4. The combo decision: reframe toward hedge discovery (don't keep as-is, don't delete the IP)

The structural detector is the crown jewel and stays verbatim. **Invert its output:** legs that "can
never all hit" with the primary bet B are exactly the legs that **pay when B fails**; `B-YES vs B-NO`
is the perfect exact complement. Concretely:

1. Add a **primary-bet B** concept + a **B-fails state set** (mirror the pipeline `paysIn` sets).
2. **Hedge-discovery mode**: invert `detectStructuralJoint` to surface candidate hedges **ranked by
   floor-reduction-per-dollar**. Almost no new math — the detector already proves, exactly, which
   positions pay in B's fail-states.
3. Replace the hardcoded `maxLossUsd = −stake` (`combo.ts:108`) with a real `state × position` payoff
   matrix `min()`, so worst-case-loss and loss-if-fails become first-class.
4. **Re-key the verdict** (`combo.ts:124`) off `comboProb` onto loss-minimization: NO_GO if the legs
   **raise** the combined worst-case loss; favorable only if a leg **lowers the floor net of premium**
   (mirror `decide.ts:202-225`).
5. **Demote** "Chance all hit" / "Payout if all hit" to a muted row; lead with worst-case loss and
   "you pay vs fair (compounded vig)".
6. Repoint the Fréchet machinery (`lib/estimate/joint.ts`) to bound the **loss-if-B-fails range under
   unknown correlation**; drop the illustrative Gaussian-copula point from the UI headline (keep in code).
7. Keep a pure parlay only as an explicit **"speculative parlay" sub-mode** that loudly states it
   **increases**, not decreases, loss. Rename the tab "Combo check" → **"Position relationship check"**.

**This is the RIGHT half of the bipolar slider (§0.1).** The combo/parlay is no longer a peer surface —
it is the *amplify* direction of the same one-bet control: the structural detector finds OFFSETTING legs
for the left (protect) and REINFORCING legs for the right (amplify), centered on the user's bet B. Same
engine, one axis, honest both ways.

Net: the combo becomes the **multi-market hedge-discovery surface** (the actual unmet need). The
"don't get ripped off on a parlay" value (compounded-vig truth-telling) survives as the speculative
sub-mode, just not as the headline.

### 4.1 Cross-category hedging — the honesty boundary

The win-floor and the worst-case loss-if-B-fails are **always exact**: arithmetic over per-state payoffs,
valid for ANY mix of markets/categories, zero probability. What is NOT free across categories is the
**claim that a leg actually reduces your worst fail-state**:

- A leg lowers the worst-case loss only if it pays in your **worst** B-fails state. That is GUARANTEED
  only when the relation is **structural** (exact, derivable): `B-NO` (exact complement, ρ=−1); rivals
  in B's single-winner set (if B fails, a rival wins); cross-event **containment inverted** — e.g.
  `NOT(B reaches the final) ⊆ NOT(B wins)`, so "B fails to reach the final" is a provable subset of
  "B fails." These cross-event/cross-type structural hedges are exactly what the inverted
  `detectStructuralJoint` surfaces — and they need **no probability**.
- For a merely "intuitively related" cross-category leg we do **NOT** fabricate a correlation (honesty
  backbone). We report only the **guaranteed payoff facts** — exactly which states it pays in — and label
  it **speculative**: it may cover SOME fail-states but is not guaranteed to cover your worst one, and its
  premium still counts against the win-floor.
- A genuinely **unrelated** leg makes the worst case WORSE (added cost, pays nothing in the binding
  fail-state). The engine must **reject** these, never surface them as hedges.

So hedge-discovery ranks candidates by **guaranteed floor-reduction-per-dollar** (structural legs first)
and offers speculative cross-category legs only as clearly-labeled extras — never as the recommended floor.
This is how "其余投注可以是别的类型" stays honest: cross-type YES, fabricated correlation NO.

---

## 5. Steelman resolution (what the skeptic forced us to keep)

- **De-vig q stays** — scoped to price-honesty + secondary context. Stripping it as "prediction" would
  break the executable-price floor (compliance). Never delete.
- **Kelly machinery stays, demoted** — an interior hedge size genuinely needs a probability OR a
  risk-preference; pure worst-case minimization trivially says "fully neutralize." Keep Kelly as a
  **labeled "growth-optimal under market-implied odds" marker on the frontier**, relabel it a
  risk-preference (not a win-prediction), and make the **default** a floor-driven posture.
- **EV / pProfit / P(all hit) stay** — honesty requires them. Demote **placement only**; keep every
  number and caveat verbatim, enforced by tests.
- **Primary objective = worst-case (no-probability)**; expected-loss (needs-probability) is secondary.

---

## 6. Prioritized backlog

### P0 — re-center the product (do first)

- **[M] Add `lossIfPrimaryFails`** (`lib/netcost/benefit.ts`), thread `winIdx` through `decide.ts` +
  `buildPlan.ts`, surface as the headline stat on `/` and `/plan`.
- **[S] Flip default basis `"cvar"` → `"maxLoss"`** (`decide.ts:86`) so the GO/PARTIAL/NO_GO verdict and
  η ride on the probability-free floor; keep CVaR/stdDev as labeled secondary context.
- **[M] Demote win-prob/payout from headlines**: move `plan/page.tsx:300-301` and `combo/page.tsx:143,147`
  into muted "market-implied context, not a forecast" sub-rows; promote worst-case floor, loss-if-fails,
  cost-of-protection. Add a `.statcell.lead` CSS modifier (`app/globals.css:254-261`) so the loss-min
  metric visually dominates without relayout.
- **[S] Add `costOfProtection`**, display it paired with loss-if-fails on `/` and `/plan`.

### P1 — the decision surface + behavior

- **[M] Materialize + expose the cost-vs-protection frontier** (`strategy.ts`): emit the grid points;
  render a two-axis mini-chart on `/plan` wired to the slider ("pay $X to cap your loss at −$Y").
- **[M] Demote Kelly** to a labeled frontier marker; **replace the `s∈[0.4,1]` slider with the keep-fraction
  `k` from §0.1** (default `k=0.5`). The slider label becomes "keep ≥ X% of your winnings"; probability-free,
  exactly the owner's intent.
- **[M] Implement the maximin LP + win-floor constraint (§0.1)** as the core solver: maximize the worst-case
  B-fails PnL subject to `PnL(ω) ≥ k·G` on B-wins states and `Σ x_j·price_j ≤ (1−k)·G`, over the existing
  `paysIn` payoff matrix. This is the engine that answers "lose the least if wrong, keep ≥ k of the win."
- **[M] Re-key the `/plan` verdict** (`buildPlan.ts:84-89`) and `/combo` verdict (`combo.ts:124`) on
  loss-min arithmetic instead of pProfit/comboProb/EV.
- **[L] Reframe `/combo` → "Position relationship check" + hedge discovery** (see §4). Stage it:
  ship headline demotion + real `maxLoss` first, then hedge-discovery as a follow-on.
- **[M] Make the `/plan` slider BIPOLAR (§0.1)**: center = no hedge (hold B alone), LEFT = protect
  (offsetting legs, `f=|t|` of winnings spent → far-left break-even/min-loss), RIGHT = amplify (reinforcing
  legs, more upside / more downside, loudly higher-risk). Default handle opens left-of-center at `f=0.5`
  (keep half your winnings). Relabel ends "极度保守 / 没中也亏不多" ↔ "极端收益 / 中了赢最多，风险高"
  (`plan/page.tsx:61-66`, `allocate.ts:48-52`). Left half drives the maximin solver; right half drives the
  combo/amplify path (§4).

### P2 — copy, jargon, residual prediction

- **[S] Encode the thesis** in PRODUCT.md Purpose and the `/`, `/plan`, `/combo` sub-headlines (the
  one-liner at the top of this doc). Rename the combo tab.
- **[M] Relabel bare η** as "protection per $1 of cost" (or tooltip); expose a maxLoss-basis η.
- Repoint `estimate/joint.ts` Fréchet to the loss-if-fails range; drop the copula point from the UI;
  confirm `estimate/calibration.ts` + `ensemble.ts` stay backtest-only.

---

## 7. Risks & mitigations

- **Kelly-removal overreach** → keep it as a labeled risk-preference marker; default to a floor-driven
  posture, never delete the q-weighted machinery (it's the only principled interior-size picker).
- **De-vig misclassified as prediction** → scope it to price-honesty + context; never strip it.
- **Honesty regression during demotion** → demote PLACEMENT only; keep every EV/pProfit/caveat verbatim;
  enforce with tests.
- **`winIdx` ambiguity for multi-state / multi-leg primaries** → define the B-wins index set ONCE at the
  pipeline level (reuse `paysIn`) and thread it to both the analytic and sim risk paths.
- **Frontier perf/UX bloat** → downsample to a handful of display points; the math is already computed.
- **Combo reframe scope creep (L)** → stage it (headline + real maxLoss first, hedge-discovery after).
- **Verdict re-keying false negatives** → keep pLoseAll/EV as supporting clauses; add regression tests on
  representative plans before changing the gate.
