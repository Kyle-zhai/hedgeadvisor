# Settlement-Proven Moat and Joint Combo Calibration

本文档记录下一阶段要建设的两层能力：

1. `settlement-proven CALIBRATED moat`：不是让 LLM 判断得更像人，而是让系统用真实结算结果证明某一类关系在历史上确实能对冲。
2. `reliable multi-leg joint combo calibration`：不是把多个单腿 hedge 简单相加，而是学习它们在同一个 anchor 失败场景下是否互相重叠、互相补充、或者其实只是同一个风险的重复表达。

当前 1000 条 gold relation examples 的价值主要在 MODELED 层：它能训练或校正模型更好地判断“两个市场之间是否有逻辑/因果/主题/共同原因关系”，例如“西班牙主力受伤”和“西班牙赢得世界杯”之间是负相关的 causal/entity-specific relation。但这 1000 条 gold 不等于 CALIBRATED 证据，因为它们不是市场冻结快照之后的真实结算样本。

换句话说：

- gold examples 训练“思考方式”和“关系判断质量”；
- settlement observations 训练“这种关系在真实市场里是否真的给过可执行的对冲收益”；
- combo observations 训练“多条腿放在一起时，联合覆盖率是否真的比单腿更好”。

## Capability Ladder

### MODELED

`MODELED` 是 LLM + gold correction 产生的判断层。

它可以回答：

- 这个候选市场和用户原始赌注之间有没有关系？
- 关系方向是 positive、negative、ambiguous 还是 unrelated？
- 关系类型是 logical、causal、behavioral、economic、information、common-cause 等哪一种？
- 如果 anchor 赢/输，candidate 大概更可能怎样？

但它不能单独证明：

- 这个 hedge historically 有效；
- 这个概率已经可用于 sizing；
- 这个 leg 可以被标成 `CALIBRATED`；
- 多腿 combo 的联合覆盖率可靠。

所以 MODELED 是发现候选、解释关系、生成先验、排序候选的能力，不是最终证据。

### CALIBRATED

`CALIBRATED` 必须来自 settlement-proven evidence。

一个 leg 能进入 CALIBRATED，至少要满足：

- candidate snapshot 在结算前被冻结；
- anchor 和 candidate 都有真实 settlement；
- 训练样本在 walk-forward evaluation 中只能使用当时已经结算的过去样本；
- 同一个真实世界事件不能被重复计数成多个独立样本；
- 两个 anchor branch 都有足够样本，例如 `anchor wins` 和 `anchor fails` 各至少 20 个有效独立样本；
- conservative lower bound 仍然显示 hedge specificity 为正；
- 没有价格、时间、标签、事件 cluster 的 leakage。

CALIBRATED 证明的是：“在过去相似结构的真实市场里，这种 hedge 类型在 anchor fail 时确实更常 payout，并且不是靠单个事件、事后筛选或当前价格泄漏得到的。”

### JOINT-CALIBRATED

`JOINT-CALIBRATED` 是未来多腿 combo 的更高目标。

它不仅要求每条 leg 本身有证据，还要求这个 combo family 的联合表现被结算数据验证过：

- leg A、B、C 在 anchor fail 时是否一起 payout，还是互相替代？
- naive coverage `1 - product(1 - p_i)` 是否高估了真实覆盖？
- 同 scenario 的多腿是否只是在重复押同一件事？
- 跨 scenario 的腿是否真正降低 uncovered failure states？
- combo 的 premium drag 是否超过了 hedge benefit？

目前系统可以组合多腿，但可靠的 joint combo calibration 需要额外数据结构和回测。

## Part I: Settlement-Proven CALIBRATED Moat

### Why Gold Is Not Enough

当前已经训练的 1000 条例子，如果它们是 Claude/Qwen/DeepSeek 判断或人工标注的 relation examples，那么它们更像 supervised judgment data。

它们能提升：

- sign accuracy；
- mechanism classification；
- conditional intuition；
- negative-control 识别；
- 对“延伸因果关系”的识别能力；
- 对“看起来相关但实际 unrelated”的拒绝能力。

但它们不能直接提升：

- realized hedge payout rate；
- market price execution quality；
- settlement-calibrated conditional probability；
- true risk reduction；
- combo joint coverage。

原因是 CALIBRATED 层要证明的是真实世界市场行为，不是语义判断是否合理。比如“西班牙主力受伤 -> 西班牙不夺冠概率上升”在逻辑上合理，但一个可交易 candidate 是否真的 payout、当时价格是否可买、是否还有 liquidity、是否已经被市场 priced in，都必须由真实 historical snapshot + settlement 来验证。

### Core Invariants

CALIBRATED moat 的核心是几个不可破坏的约束。

### 1. Freeze Before Resolution

每个 candidate 必须在相关市场结算前被记录到 `association_candidate_snapshot` 或等价快照表中。

快照至少要包含：

- `observedAt`：发现 candidate 的时间；
- `anchorVenue`、`anchorMarketId`、`anchorOutcomeId`；
- `candidateVenue`、`candidateMarketId`、`candidateOutcomeId`；
- anchor title/rules；
- candidate title/rules；
- candidate side；
- 当时可执行或近似可执行的 price；
- relation hypothesis；
- relation key；
- mechanism graph；
- model name；
- prompt/config version；
- candidate rank；
- discovery source；
- cluster key；
- event key；
- scenario bucket。

如果 candidate 是结算之后才被发现的，它不能进入 walk-forward evidence。

### 2. Settlement Is Separate From Model Judgment

LLM 可以提出 hypothesis，但不能写入 `association_observation` 作为 evidence。

正确链路应该是：

```text
market snapshot -> LLM relation hypothesis -> frozen candidate snapshot
frozen candidate snapshot + later settlement -> observation
observation pool -> calibration posterior
calibration posterior -> CALIBRATED gate
```

错误链路是：

```text
LLM thinks relation is strong -> mark as calibrated
```

这条边界必须很硬，否则 moat 会变成模型自我确认。

### 3. Cluster-Dedup

同一个真实世界事件不能重复贡献大量样本。

例如：

- Spain wins World Cup；
- Spain reaches final；
- Spain top scorer；
- Spain group winner；
- Spain star injury；
- Spain coach leaves。

这些可能都属于同一个 `eventCluster` 或强相关 cluster。即使有 20 个 market rows，也不应该算作 20 个独立样本。否则系统会误以为样本量很大，实际只是一个事件被切成多个盘口。

读 calibration count 时，应按 cluster 做 effective sample normalization：

- 同 cluster 内多个 rows 可以保留用于诊断；
- 进入 posterior 的有效权重应该被 capped 或 normalized；
- walk-forward split 中，test cluster 不应出现在 training cluster 中。

### 4. No Future Leakage

回测时不能使用任何 test settlement 之后才知道的信息。

需要防止：

- 用今天的 market title/rules 解释过去；
- 用今天价格替代历史价格；
- 用结算后才出现的 candidate；
- 用 test event 的 sibling markets 调参；
- 用最终 winner list 生成 historical manifest；
- 用 same cluster 的 resolved markets 训练 test market；
- 用现成标签间接包含 outcome。

如果某条数据没有真实 `observedAt`、`resolvedAt`、historical price，就应该跳过，而不是补当前值。

### Relation Key vs Calibration Bucket

系统需要两层 key。

### Exact Relation Key

`relation_key` 用于存储和审计具体 pair。它应该尽量细：

- anchor event family；
- candidate event family；
- settlement predicate；
- relation direction；
- payoff side；
- mechanism type；
- mechanism edge kinds；
- scope；
- time order；
- event ontology version；
- candidate side。

这个 key 适合回答：“这个 exact relation template 历史表现如何？”

但 exact relation key 的问题是太稀疏。新问题通常没有完全相同历史。

### Generalized Calibration Bucket

泛化应该走更粗的 bucket，例如：

```text
role x mechanismType x relationDirection x candidateSide x scenarioBucket
```

其中：

- `role`：same_entity、entity_specific、event_global、cross_entity、cross_domain 等；
- `mechanismType`：logical、causal、behavioral、economic、information、common_cause 等；
- `relationDirection`：positive、negative、ambiguous；
- `candidateSide`：yes/no；
- `scenarioBucket`：多腿 combo 所需的场景分类。

这层 bucket 回答：“这类结构的 hedge 历史上是否有效？”

当前引擎已有 coarse structure pooling 的方向：用 settled observations 按 role、mechanism type、side 重分桶，再用 beta-binomial 拟合 realized `P(candidate pays | anchor fails)`。下一步要把它变成更严格的 settlement-proven moat：加入 scenario、cluster、walk-forward、价格和 combo evidence。

### Calibration Counts

单腿 calibration 至少要统计四个 count：

```text
anchor wins, candidate pays
anchor wins, candidate fails
anchor fails, candidate pays
anchor fails, candidate fails
```

由此估计：

```text
P(candidate pays | anchor wins)
P(candidate pays | anchor fails)
hedge specificity = P(candidate pays | anchor fails) - P(candidate pays | anchor wins)
```

如果 hedge 是为了保护 anchor fail，那么好的 hedge 应该满足：

```text
P(candidate pays | anchor fails) > P(candidate pays | anchor wins)
```

但不能只看 posterior mean。需要看 conservative interval。

推荐使用 Jeffreys beta-binomial：

```text
alpha_prior = 0.5
beta_prior = 0.5

posterior_fail = Beta(candidate_pays_when_anchor_fails + 0.5,
                      candidate_fails_when_anchor_fails + 0.5)

posterior_win = Beta(candidate_pays_when_anchor_wins + 0.5,
                     candidate_fails_when_anchor_wins + 0.5)
```

然后用 conservative lower bound 判断 hedge specificity：

```text
hedgeSpecificityLower =
  lowerBound(P(candidate pays | anchor fails))
  - upperBound(P(candidate pays | anchor wins))
```

只有当 `hedgeSpecificityLower > 0` 时，才说明在保守置信区间下它仍然像 hedge，而不是 noise。

### Promotion Gate

一个 leg 从 MODELED 升到 CALIBRATED，建议至少满足：

- `samplesWhenAnchorFails >= 20`；
- `samplesWhenAnchorWins >= 20`；
- effective independent clusters 足够，不只是 rows 足够；
- `hedgeSpecificityLower > 0`；
- candidate side 的 settlement predicate 清晰；
- candidate 在 observedAt 时有可交易 price；
- relation bucket 不是 `INSTANCE_ONLY`；
- relation bucket 不是 `UNRELATED`；
- cluster-disjoint walk-forward backtest 无明显 degradation；
- strict posture 下仍能解释为 hedge，而不是只在 model expected value 下好看。

如果样本少，但 LLM 判断很强，最多仍然是 MODELED，不是 CALIBRATED。

### Walk-Forward Backtest

CALIBRATED moat 的核心评估应该是 walk-forward。

对每个 test settlement：

1. 找到它结算前已经冻结的 candidate snapshot。
2. 找到 test resolvedAt 之前已经结算的 historical observations。
3. 排除同 cluster 的训练样本。
4. 按当时可用训练集构建 calibration bucket。
5. 用当时的 posterior 预测 test candidate payout。
6. 用当时的 price 计算 hedge cost 和 payoff。
7. 记录真实 outcome。

不能先把全部历史训练完再评估全部历史，否则会泄漏。

### Metrics

单腿 moat 的 dashboard 应至少包含：

- Brier score；
- log loss；
- ECE；
- actionable coverage；
- average fail-loss reduction；
- win drag；
- premium spent；
- realized payout rate when anchor fails；
- realized payout rate when anchor wins；
- hedge specificity mean；
- hedge specificity conservative lower；
- leakage violation count；
- skipped rows by reason；
- effective independent clusters；
- sample balance by anchor branch；
- calibration by bucket；
- calibration by venue；
- calibration by model version；
- calibration by scenario bucket。

关键不是只看“命中率”，而是看当 anchor fail 时是否真的降低损失，同时 anchor win 时 premium drag 是否可接受。

### Milestones

这里的 sample 应该指 independent clusters 或有效样本，不是普通 row count。

### 100 Independent Clusters

这个阶段可以做初步 sanity check：

- 哪些 bucket 明显无效；
- 哪些 relation type 的 sign 经常错；
- 哪些 domain 特别容易 leakage；
- 哪些 venue 的历史价格质量差；
- 是否有 candidate discovery bias。

此阶段不应该大规模自动 CALIBRATED。

### 300 Independent Clusters

这个阶段开始可以形成初步规则：

- same entity logical/implication 可能较快稳定；
- entity-specific causal 可能开始出现可靠方向；
- cross-domain 通常需要更保守；
- unrelated/negative-control 的 false positive 应该下降。

可以允许少数高样本、高 specificity bucket 进入 CALIBRATED。

### 500 Independent Clusters

这个阶段可以开始优化 sizing 和 ranking：

- posterior interval 更窄；
- bucket fallback 更可信；
- walk-forward metrics 更有解释力；
- 可以比较不同 model chain 产生的 candidate quality。

### 1000+ Independent Clusters

这个阶段才更接近 moat：

- 可证明哪些关系类型长期有用；
- 可拒绝哪些“听起来聪明但市场上没用”的关系；
- 可用 settlement evidence 调整 LLM 发现策略；
- 可对不同 bucket 设置不同 premium limits；
- 可开始训练 combo overlap。

注意：当前 1000 条 gold examples 如果不是 settlement observations，就不等于这里的 1000 independent clusters。

### Required Product Behavior

当用户输入：

```text
我的赌注是西班牙赢得世界杯
```

系统可以用 MODELED 层想到：

```text
Spain star injured -> Spain championship probability decreases
```

但要给出真正高质量 hedge，它还需要：

1. 在 Polymarket/Kalshi 里找到可交易 candidate；
2. 确认 candidate 的 resolution rules 真能表达“主力受伤/无法上场/球队表现受损/替代路径”；
3. 读取当时价格；
4. 判断这个 relation bucket 是否有 settlement-proven evidence；
5. 如果没有，只能标 MODELED；
6. 如果有，才能进入 CALIBRATED；
7. 如果多腿一起推荐，还要判断这些腿是否覆盖不同 failure scenarios。

## Part II: Reliable Multi-Leg Joint Combo Calibration

### Why Single-Leg Calibration Is Not Enough

假设系统找到三条 hedge：

```text
A: Spain star injury
B: Spain fails to reach final
C: Brazil wins World Cup
```

每条单独看都可能和“Spain wins World Cup”负相关。

但 combo 不能简单相加。原因是：

- A 和 B 可能高度重叠：star injury 发生时，Spain fails to reach final 更可能发生；
- B 和 C 可能部分互斥或竞争：Brazil wins 是 Spain fails 的一种路径，但不是所有路径；
- A 可能只是 causal driver，B 是 downstream outcome；
- 三条腿可能都在保护同一个 failure state，却没有覆盖其他 failure state；
- premium 会叠加，导致 anchor win 时 drag 太大；
- naive independence 会严重高估 coverage。

所以可靠 combo 要学习的是 joint distribution，不只是每条腿自己的 conditional payout。

### Current Engine Behavior

当前引擎已经有一些正确的基础：

- 每条 leg 有 confidence tier：`ANALYTIC`、`CALIBRATED`、`MODELED`；
- combo 的 tier 取 weakest leg；
- multi-leg combo 通过 `eventDimension` 或类似维度控制，避免完全重复；
- strict worst-case loss 和 model-based expected loss 分开；
- soft leg 不会伪装成 structural coverage。

这能让 combo 在产品层面诚实展示，但还不能证明 combo 的 joint coverage 已经可靠。

### Scenario Buckets

要做可靠多腿，最重要的新增字段之一是 `scenarioBucket`。

建议至少从这些 bucket 开始：

- `logical_subset`：reach final、win group、win championship 这类集合关系；
- `rival_wins`：竞争对手赢导致 anchor 输；
- `path_elimination`：anchor 被淘汰、未晋级、未达阈值；
- `injury_absence`：关键人缺席、伤病、停赛；
- `performance_collapse`：球队/公司/候选人表现显著低于预期；
- `macro_regime`：利率、通胀、经济增长、政策环境；
- `regulatory_shock`：法律、监管、禁令、审批；
- `supply_demand_shock`：商品、能源、供应链、库存；
- `information_release`：财报、CPI、就业数据、民调、审判结果；
- `behavioral_reaction`：市场/选民/用户/观众行为反应；
- `unrelated_control`：负样本，帮助模型学会拒绝。

`scenarioBucket` 的作用不是替代 relation type，而是描述 hedge 覆盖的是 anchor failure 的哪一种路径。

例如对 “Spain wins World Cup”：

- “Spain star injured” 是 `injury_absence`；
- “Spain eliminated before semifinal” 是 `path_elimination`；
- “Brazil wins World Cup” 是 `rival_wins`；
- “Spain coach resigns before tournament” 可能是 `performance_collapse` 或 `information_release`；
- “Euro inflation above 3%” 大概率 unrelated。

多腿 combo 应优先覆盖不同 scenario，而不是买很多同 scenario 的重复腿。

### Pairwise Overlap

对任意两条 legs A 和 B，需要估计它们在 anchor fail 条件下的重叠：

```text
P(B pays | A pays, anchor fails)
P(B pays | A fails, anchor fails)
P(A pays and B pays | anchor fails)
P(A pays or B pays | anchor fails)
```

如果：

```text
P(B pays | A pays, anchor fails)
```

远高于：

```text
P(B pays | A fails, anchor fails)
```

说明 A 和 B 在 failure states 中高度重叠。

高重叠不一定坏，但它意味着第二条腿的 marginal coverage 较低。它可能只是增加 payout size，而不是覆盖新失败路径。

### Conservative Combo Coverage

naive independence 会写成：

```text
coverage = 1 - product(1 - p_i)
```

其中 `p_i = P(leg_i pays | anchor fails)`。

但这通常太乐观。

v1 可以使用 conservative overlap penalty：

```text
adjustedMarginal_i = p_i * (1 - overlapPenalty_i)
coverageLower = 1 - product(1 - adjustedMarginal_i)
```

`overlapPenalty_i` 可以先用规则，再逐步由 settlement 学习。

初始规则建议：

```text
same associationGroup: exclude or penalty 1.00
same exact event: penalty 0.80-1.00
same scenarioBucket: penalty 0.60-0.85
same entity + same downstream path: penalty 0.50-0.80
different scenarioBucket but same domain: penalty 0.20-0.50
different scenarioBucket and historically low overlap: penalty 0.00-0.25
unknown cross-domain: penalty 0.50 until proven
```

这些数字不是最终真理，而是上线前防止 combo 过度乐观的 conservative prior。

### Combo Snapshot

要训练 combo，必须冻结“当时系统会推荐的组合”，而不是事后从 winners 中拼组合。

建议新增或逻辑生成 combo snapshot：

```text
association_combo_snapshot
  id
  anchorSnapshotId
  observedAt
  anchorMarketId
  anchorOutcomeId
  comboPolicyVersion
  comboTier
  totalPremium
  strictWorstLoss
  modeledExpectedLoss
  calibratedExpectedLoss
  coverageEstimate
  coverageLower
  selectedLegCount
  selectionReason
  modelChainVersion
  createdAt
```

以及 legs：

```text
association_combo_leg_snapshot
  comboSnapshotId
  legSnapshotId
  legRank
  candidateMarketId
  candidateOutcomeId
  candidateSide
  price
  scenarioBucket
  relationKey
  calibrationBucket
  singleLegTier
  singleLegPayoutIfAnchorFails
  overlapPenalty
  marginalCoverageEstimate
```

结算后生成 observation：

```text
association_combo_observation
  comboSnapshotId
  anchorResolvedAt
  anchorPays
  comboPaysAny
  comboPayoff
  premiumSpent
  realizedFailLossReduction
  realizedWinDrag
  legsPaidCount
  paidLegIds
```

如果不想马上建表，也可以先从现有 candidate snapshots + recommendations logs 派生，但必须保证 observedAt 是真实推荐时刻，而不是事后重建。

### Combo Backtest

combo backtest 应该按 walk-forward 运行：

1. 在时间 T，用户 anchor 尚未结算；
2. 系统根据当时 market universe 发现 candidates；
3. 系统根据当时已结算历史选择 combo；
4. 冻结 combo snapshot；
5. 等 anchor 和 legs 结算；
6. 记录真实 combo payoff；
7. 后续评估只能用 T 之前已知信息。

需要报告：

- realized coverage when anchor fails；
- premium drag when anchor wins；
- average fail-loss reduction；
- strict worst-case loss；
- model expected loss；
- calibrated expected loss；
- predicted vs realized coverage；
- combo Brier/log loss/ECE；
- marginal contribution by leg rank；
- overlap by scenario pair；
- duplicate-risk rate；
- skipped combos by reason；
- combo tier distribution；
- worst losing combo examples；
- best successful combo examples。

### Joint Calibration Tiers

建议把 combo 的 tier 拆得更清楚。

### MODELED Combo

任意 leg 是 MODELED，或者 combo overlap 只靠模型判断，则 combo 是 MODELED。

这不代表不能展示，而是要明确告诉用户：这是关系推理生成的组合，不是 settlement-proven combo。

### CALIBRATED-Leg Combo

所有 legs 都是 CALIBRATED，但 joint overlap 还没有足够历史。

这比 MODELED 好，因为每条腿单独有证据；但 combo coverage 仍要保守，不能按独立事件相加。

### JOINT-CALIBRATED Combo

combo family 本身有足够 settlement evidence。

Promotion gate 可类似：

- combo family effective clusters >= 100；
- anchor fail branch 样本足够；
- realized coverage lower bound 大于 best single-leg lower bound；
- marginal contribution of second/third leg 为正；
- premium drag 可接受；
- walk-forward ECE 可接受；
- scenario overlap 估计稳定；
- 没有 single cluster 主导结果。

这可以作为未来的产品 moat 标签，不建议现在就承诺。

### Combo Selection Policy

v1 的多腿策略可以这样写：

1. 先选 single-leg score 最好的候选。
2. 对后续候选计算 marginal utility，而不是 raw utility。
3. 如果和已选 legs 同 `associationGroup`，拒绝。
4. 如果同 exact event，强 penalty 或拒绝。
5. 如果同 `scenarioBucket`，只在 price 很低或 payout structure 明显不同的情况下允许。
6. 优先补充不同 scenarioBucket。
7. combo leg 数量默认 2-3，最多 4。
8. 每增加一条腿，都必须降低 expected fail loss 或提高 conservative coverage。
9. 如果 premium drag 超过用户保留收益目标，停止加腿。

伪代码：

```ts
for candidate in rankedCandidates:
  if combo.length >= maxLegs:
    break;

  if sameAssociationGroup(candidate, combo):
    continue;

  const overlapPenalty = estimateOverlap(candidate, combo);
  const marginalCoverage = candidate.pFailPayout * (1 - overlapPenalty);
  const marginalCost = candidate.price * stakeScale;
  const marginalUtility = failLossReduction(marginalCoverage) - winDrag(marginalCost);

  if marginalUtility <= 0:
    continue;

  if violatesStrictWorstLoss(candidate, combo):
    continue;

  combo.push(candidate);
```

### Settlement Learning for Overlap

随着 combo observations 增加，可以从规则 penalty 过渡到 learned penalty。

建议学习粒度：

```text
scenarioBucketA x scenarioBucketB x roleA x roleB x mechanismTypeA x mechanismTypeB
```

输出：

```text
overlapRateWhenAnchorFails
jointPayoutRateWhenAnchorFails
secondLegMarginalCoverage
confidenceInterval
effectiveClusters
```

当样本不足时，fallback 到 conservative prior。

### Minimum Viable Implementation

第一版不需要一步到位。推荐顺序：

### Phase 0: Keep Current Combo Honest

- combo tier = weakest leg；
- strict worst-case loss 单独展示；
- MODELED leg 不伪装成 CALIBRATED；
- combo coverage 保守；
- 不宣称 joint-calibrated。

### Phase 1: Add Scenario Metadata

- 给 relation hypothesis 增加 `scenarioBucket`；
- 给 candidate snapshot 存 `scenarioBucket`；
- 给 recommendation logs 存 selected legs；
- `/api/diag/stats` 展示 scenario distribution；
- gold examples 中补充 scenario labels。

### Phase 2: Add Pairwise Overlap Logging

- 每次推荐 combo 时记录 pairwise relation；
- 记录 same event、same entity、same scenario、same association group；
- 记录当时使用的 overlap penalty；
- 结算后计算 pairwise realized overlap。

### Phase 3: Conservative Overlap Policy

- 不允许 same associationGroup 多腿；
- same scenario 默认高 penalty；
- unknown cross-domain 默认中高 penalty；
- different scenario 给予更高 marginal credit；
- premium drag 作为硬约束。

### Phase 4: Combo Walk-Forward Backtest

- 使用历史 frozen combo snapshots；
- 评估当时会推荐什么；
- 比较 single-best leg vs combo；
- 输出 fail-loss reduction、win drag、coverage calibration、marginal contribution。

### Phase 5: Learned Joint Calibration

- 从 pairwise overlap 学 penalty；
- 从 combo family 学 coverage lower；
- 给满足 gate 的 combo family 标 `JOINT-CALIBRATED`；
- 仍然保留 strict worst-case loss。

## How This Answers the Product Goal

用户的目标是：下次用户给出自己的赌注后，系统能给出好的对冲策略。

这是同类型问题，但不是同一个 exact problem。它需要两种泛化：

1. 语义/因果泛化：从 gold examples 学会“什么关系可能是 hedge”。
2. 市场/结算泛化：从 settlement observations 学会“哪些 hedge 类型在真实盘口中真的有效”。

所以整套模式可以换底层模型继续跑通，前提是接口输出结构稳定：

- relation hypothesis；
- mechanism graph；
- conditional prior；
- scenario bucket；
- counterexamples；
- confidence；
- model metadata。

底层模型越强，通常能提高 candidate discovery 和 relation judgment；但 CALIBRATED moat 仍取决于 settlement evidence。更强模型不是直接让训练效果变成 CALIBRATED，而是让进入 settlement pipeline 的候选质量更高，从而更快积累有效证据。

## Practical Priority List

最应该优先做的事情：

1. 全量或近全量 market radar：持续扫描 Polymarket/Kalshi，冻结候选快照。
2. Settlement ingestion：稳定拿到 anchor/candidate 的真实结算。
3. Cluster-dedup：防止一个事件被算成几十个样本。
4. Walk-forward backtest：只用当时已经知道的信息评估。
5. Bucket calibration dashboard：显示哪些 bucket 真的变强。
6. Scenario bucket：为多腿 combo 做准备。
7. Combo snapshot logging：记录当时推荐的组合。
8. Pairwise overlap metrics：学习腿与腿之间是不是重复。
9. Conservative combo policy：上线前先用保守 penalty。
10. Joint combo calibration：等 combo settlement 样本足够后再标更高 tier。

## Non-Negotiable Honesty Rules

- Gold data never promotes CALIBRATED.
- LLM output never writes settlement evidence.
- No snapshot after resolution can enter backtest.
- No current price can replace historical price.
- No same-cluster leakage in walk-forward evaluation.
- No combo should assume independence unless settlement proves it.
- No multi-leg strategy should hide premium drag.
- No MODELED leg should be described as settlement-proven.
- No single event should dominate a bucket.
- No product label should promise `JOINT-CALIBRATED` before joint settlement evidence exists.

## Summary

当前 1000 条 gold examples 很有价值，但它们主要提升的是 MODELED relation judgment。要达到之前说的真正 moat，需要继续积累 settlement-proven observations，并用严格的 frozen snapshot、cluster-dedup、walk-forward backtest 和 beta-binomial calibration 把一部分关系 bucket 升级为 CALIBRATED。

多腿 combo 的下一步不是“让模型想更多腿”，而是“证明这些腿覆盖不同 failure states”。这需要 scenario buckets、pairwise overlap、combo snapshots 和 joint backtest。先用 conservative overlap policy 保持诚实，再等 settlement 数据足够后学习真正的 joint calibration。
