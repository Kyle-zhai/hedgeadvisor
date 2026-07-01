# 跨维度因果对冲：绕开"慢结算数据"的替代方案

> 目标（owner 2026-06-30 设定）：用户在某预测平台下注后，用引擎 + LLM 初始解析，跨平台寻找与该赌注**逻辑/因果关联、跨维度**（非简单正反）的其他赌注，给出多个对冲方案。痛点：现引擎把"能不能推荐"绑死在**难采集、累积极慢的市场结算数据**上。本文档是**研究 + 方案**，先不改代码。
>
> 研究方式：7 条并行研究线（LLM 预测校准 / 因果知识图 / 市场关联发现现状 / 外部数据代理校准 / LLM 建因果图 / 无标注置信度 / 代码测绘）+ 一轮 **8-agent 对抗验证**（4 视角批判 → 逐条独立 CONFIRMED/REFUTED）。方案的 file:line、置信梯、量化声明都经过代码核对与反驳；见 §10 验证记录。文末附全部一手文献。
>
> **本文档不是实现说明，是"方向 + 边界 + 落点"的方案。凡说"复用/新增"的地方，§3 与 §10 的"已有 vs 全新"清单为准。**

---

## §0 结论先行

**网上有没有现成替代方案？** 分两层：

1. **产品层：没有。** 竞品全景确认——Prediction Hunt、agg.market、Matchr、Polymarket Combos、Kalshi、Metaculus/Manifold 全都只做**"等价合约"跨场匹配套利**（同一事件不同平台），**没有任何产品去发现"逻辑/因果关联但不同维度"的市场来做对冲**。这块空白正是本产品差异点。（vein-3）

2. **方法层：有，而且高度收敛。** 2024–2026 学术前沿（三篇直接对口论文 + 因果推理/校准/贝叶斯收缩多条线）**独立地收敛到同一套架构**：
   > **用 LLM 做"结构 + 方向"（可靠），用市场价格做"边际概率"，用 Fréchet + 单调性做"硬边界"，用外部丰裕数据 + 经验贝叶斯做"先验校准"，用真实结算只做"最终升级 + 再验证"。绝不直接吐 LLM 的数字，绝不把未结算的东西冒充已证明。**

所以：**不是从零发明，而是把已收敛的方法组装成贴合本引擎、且不破坏诚实底线的方案。** 核心动作——**把"判断因果关系真不真"（数据丰裕）与"证明这是可执行对冲"（数据稀缺）解耦**：前者立刻可做，后者继续慢慢证明；两者之间插入一个**诚实标注、且结构上不可冒充结算证明的新置信层**，让引擎**现在就能推荐**这类跨维度因果对冲，而不必空等 20 个结算样本。

**一句诚实的范围限定（验证补正）：** 因为引擎的联合对冲会计只对**互不重叠**的腿才 Fréchet-safe，且当前 optimizer 硬性**只给 1 条 soft 腿**（见 §5 护栏 8），所以"多个对冲方案"= **多条结构强制的 ANALYTIC 腿 + 至多 1 条 soft 因果腿**，而非任意堆叠多条因果腿。（§17 最终细化：上限=每个**结构互斥**失败格 ≤1 条 elicited soft 腿；格内/未证不相交的加性需 ANALYTIC 互斥证明或 JOINT-CALIBRATED 结算证据——joint calibration 不是唯一通路。）真正的跨维度因果差异点，落在那**1 条 soft 因果腿**（如"西班牙球员金靴"）+ 对因果版图的解释上。

---

## §1 诊断：被绑死的两类数据

现引擎的瓶颈不在"发现"，而在"敢不敢推荐"。它要求一个关系必须先积累 **~20 个独立结算样本**（`lib/association/calibration.ts:120` `calibrateConditionalPayoff(..., minSamplesPerBranch=20)`，判据 `win.samples≥20 AND fail.samples≥20`，`lib/association/calibration.ts:135`）才肯从 MODELED 升到 CALIBRATED。结算样本累积极慢（一届世界杯 4 年、一个 Fed 周期一个独立样本），于是 CALIBRATED 覆盖率 ~2.4%（基本只剩一个 bucket），真正有意思的跨维度因果对冲永远停在 MODELED / 被拒。

**关键洞察：结算数据同时在干两件本可分开的事。**

| 结算数据在做的事 | 真的稀缺吗 | 能换源吗 |
|---|---|---|
| **(a) 因果关系真不真、方向、强度**（西班牙主力伤 → 夺冠概率↓） | ❌ 不稀缺——几十年体育史 / 新闻档案 / 因果知识图里 base rate 很多 | ✅ 换成"外部真实世界数据 + LLM 结构判断"，无需等市场结算 |
| **(b) 这是不是可执行的对冲**（那个候选市场当时买得到、没被 priced-in、有流动性、anchor 失败时确实 payout） | ✅ 真稀缺——每个独立真实事件才贡献一个样本 | ⚠️ 部分可用**实时订单簿快照 + Fréchet/priced-in 检查**替代 |

`docs/settlement-moat-and-joint-combo-calibration.md:8` 里 owner 亲手写的那句正是这条分界线，用的就是本任务的例子：
> "西班牙主力受伤"和"西班牙赢得世界杯"之间是负相关的 causal/entity-specific relation……但这 1000 条 gold 不等于 CALIBRATED 证据，因为它们不是市场冻结快照之后的真实结算样本。

**引擎慢，是因为它用 (b) 的慢证据去放行本质属于 (a) 的因果判断。** 方案的全部目的，就是把这两件事解耦。

**硬约束（诚实底线）：** "西班牙主力受伤""西班牙换帅"这类市场，在 Polymarket/Kalshi 上**多半根本没有可交易合约**。honesty backbone 要求 real markets only，绝不虚构。所以方案不只要解决"校准慢"，还要处理"跨维度因果邻居 → 是否存在可交易市场"的映射与**诚实取舍**（有市场才成腿，没市场就作解释、不成腿）。**这也是产品能否成立的关键未知数**（见 §7 需实测命中率）。

---

## §2 网络研究结论（压缩版，决定性证据）

六条研究线的收敛点：

### 2.1 LLM 能干什么、不能干什么（veins 1/5/2）
- **强：结构 + 方向（sign）。** Kıcıman et al. 2023 在 Tübingen 因果方向基准上 **97%**（旧 SOTA 83%），事件因果 86%。方向判断在**训练里高频出现的公共领域（体育/政治/宏观）**尤其可靠（"causal parrot"——它在**复述**广泛陈述过的因果知识，恰好就是我们要的"主力受伤→球队变弱"这类）。
- **弱：形式因果发现 + 数值大小。** Corr2Cause：从相关性推因果，GPT-4 ≈ 29% F1（随机 13.5%），且微调后一改写就崩（OOD −62 F1）。verbalized 概率系统性**过度自信**（名义 99% 区间实际只覆盖 ~65%；ECE 可达 0.30）。
- **推论（架构级）：** 让 LLM 出**拓扑 + 方向**，**丢掉它的数值**；用**因果次序（causal order）**而非逐边更稳（Long et al. 2023）。

### 2.2 谄媚偏差——本任务的头号地雷（vein 1）
用户的输注写在 prompt 里，模型会**系统性高报"这个对冲会赔付"**。量化：SycEval（arxiv 2502.08177，7 个模型族）测得当用户陈述某错误信念时，模型附和的比例 **46.6%–95.1%（均值 63.7%）**；ELEPHANT（2505.13995）另测"社交谄媚"（迎合用户 +50pp）。→ **必须对用户意图盲化 prompt，双向对称 elicit（同时问 pays|fails 与 pays|succeeds 并查一致性），并加对抗性"论证它不赔"的一轮，且在两轮实质分歧时 ABSTAIN。** 现引擎的独立性护栏只是**单条脆弱正则**（`lib/association/elicit.ts` 约 :118 注释、:124 正则，命中 "no concrete mechanism"/"independent" 才强制 pWin=pFail）——**会漏掉"编出一个貌似合理机制"的谄媚（恰是最危险的一类）**，需升级成带阈值的一致性门（见 §5 护栏 1）。

### 2.3 因果邻居可以"接地"，不必凭空猜（vein 2）
可下载的因果知识图能给 LLM 的候选边**接地打分**：**CauseNet**（网络挖掘 concept→concept 因果，Precision 版 96% 精度 20 万边，可 1–2 跳游走）、**ATOMIC²⁰²⁰/COMET**（if-then 因果，对**未见事件**生成 xEffect/Causes）、**ASER**（4.38 亿事件级 Result/Precedes 图）、**ConceptNet**（有 REST API 的 Causes/HasSubevent）。用法：LLM 提出的每条因果边，若在 KG 里也有支撑边则加 grounding score，纯 LLM 的降级标注。**这些通用图对我们的领域是 OOD，主要提升 recall/先验，不是精度**——精度靠自一致性 + Fréchet 界 + 活跃市场存在性 + 价格/EV 门把关。

### 2.4 用外部丰裕数据做校准——方案承重墙（vein 4/5）
- **reference-class forecasting（外部视角）：** "主力受伤后夺冠热门出局的历史频率"可从几十年体育史直接读。配方：最宽可辩护参照类起步 → 客观因子逐步收窄 → 分解成独立因果通道 → **多种参照类构造取平均** → 零发生用 Laplace 1/(n+2)。
- **经验贝叶斯 / 分层收缩（Efron–Morris/James–Stein）：** "多 bucket、每 bucket 少样本"正是收缩的经典场景。每个 bucket 用**外部先验起步，按 `n/(n+k)` 随真实结算样本向自身市场频率迁移**；**优先分层贝叶斯**（收缩目标自带诚实误差棒），而非 plug-in EB（低估不确定性）。
- **量化杀手锏，但带 caveat（vein 5，已核对原文）：** LLM 建 BN 的实验（arxiv 2505.15918 §6.7）原文示例：**"仅 3 个真实样本 + LLM 先验，其 KL 散度已优于纯 30 个数据样本"**——这是论文自己的示例，非杜撰（§10 已核实）。**但适用范围有限**：在**离散 BN、≤5 个父节点、同域**下按**中位数 KL** 衡量；能否迁移到预测市场未验证。"≈30–100 样本效率"是对该文献的宽松概括（"30"直接可溯，"100"是 per-parameter 概括框架的说法），实现时应视作**加速冷启动的先验**，不是精度保证。

### 2.5 硬边界——不可过度授信（vein 5，部分已在代码里）
从两个市场边际 P(A)、P(B)（价格现成）可得**无假设的 Fréchet 界**：
```
条件：  max{0, P(A)+P(B)−1}/P(B) ≤ P(A|B) ≤ min{P(A),P(B)}/P(B)
```
`lib/association/optimizer.ts:88-91` / `:125-128` 已有的 clamp，是把**已校准/结构的 pFail 单向上限裁到边际允许的窗内**（防止把小边际候选当成近乎必赔的对冲）。**方案要用它的地方要诚实分清两种用法：**
- **可以**：把这个**单向可行性上限**前置到发现阶段——纯粹裁掉越界值，无假设。
- **危险（新用法，需限制）**：用 **LLM 的 sign 去挑 Fréchet 的哪一半窗并收紧**。LLM 方向有 ~14% 错误 + 谄媚翻转，一旦挑错半边，会把一个"自信收窄却围着错值"的子区间当成硬边界呈现。→ **纪律：只有 STRUCTURAL/ANALYTIC 单调性（逻辑子集/互斥）才允许 sign 挑半窗；LLM 因果 sign 不确定时保留完整双边窗，并同时报出原始 Fréchet 宽度**，注明"经 sign 收窄的区间继承了 LLM 方向误差、非无假设"。

### 2.6 无标注也能给可信置信度（vein 6）
四条独立证据轴，**两条在 n=0 就能算**（结构确定性 S、推理/证据强度 E）+ 模型一致性 M + 结算 D。
- **S（结构，n=0）：** 逻辑/机械强制（互斥、子集、算术补、Dutch-book 一致）→ 最高层。
- **E（推理/证据，n=0）：** argumentative coherence（Gorur 2025：推荐方向/大小是否与模型自陈论证图一致；过滤不一致的实测提升准确率）+ 证据检索深度 + **异模型族** LLM-judge。
- **M（模型一致性，n=0 但必须多样化）：** semantic entropy / CoCoA。**重锤警告：一致性只有在"异模型族、独立"时才与正确性相关；辩论驱动的共识会 herding 成"自信的错误共识"——用多样性，不要迭代辩论。已核实（§18#3 + `modelFallback.ts:3-13`）：现链是**单应答顺序回退**（每次调用只有一个模型作答，非并行采样），且以 Qwen 系为主（7/9，另 1 为 Qwen 蒸馏）、全经同一 DashScope 端点——**M 轴今天不存在**；要 M 轴需并行、跨族（真正非 Qwen 且非其蒸馏）采样。**
- **D（结算，慢）：** beta-binomial + 分层收缩，诚实报 rule-of-three 上界（20 次 0 失败，真实失败率仍可能高达 ~15%）。
- **门控警告（重要）：** 论文里的 **selective-conformal 保形风险门需要有标注的校准集**。GROUNDED 层按定义"0 结算样本"，**没有可校准的标签，保形保证在该层是空的**——所以不能靠它防"洪水"。GROUNDED 的准入必须靠**别的**东西：窄 Fréchet 区间 + 价格/EV 门 + 明确的"每次查询最多 N 条 GROUNDED 腿 + 明确 abstain 阈值"（见 §4/§5）。

### 2.7 三条血泪警告（vein 3）
- **分布漂移：** Semantic Trading 论文同指标从 **73%→51%（overall accuracy）/ 62%→41%（cluster accuracy）** 单月下滑（原文两张表；不要跨指标拼成 73%→41%）——关系规则会衰减，CALIBRATED/GROUNDED 要 gated + 周期再验证，不能永久信任。
- **"发现 ≠ 可交易"：** 一项**小样本（13 对）**研究发现多数被 LLM 检出的依赖无法盈利交易（Bawa 2025，非同行评审博客；更稳的证据见 IMDEA 论文 2508.03474）——逻辑关联是必要非充分，必须叠**流动性/成本/执行**过滤。
- **数据无关的即时信号：** Paleka/Tramèr（ICLR 2025 oral）的 Dutch-book 一致性检查在**零真实数据**下就能算，且与未来 Brier 相关——可作 ANALYTIC 层的 day-1 信号。

---

## §3 方案："证据接地"五段式管线 + 新置信层

一句话：**PROPOSE → GROUND → BOUND → VERIFY → CALIBRATE-over-time**。产出**有界、有向、多轴置信**的候选，**结算只在最后把某类关系升到"已证明"**。

**先分清"已有 vs 全新"（验证补正，防止把全新当复用）：**

| 已存在、可复用 | 全新、需实现 |
|---|---|
| `lib/association/optimizer.ts` 的 ANALYTIC/CALIBRATED/MODELED 三支 + Fréchet 单向 clamp（:88-91,:125-128）+ soft-leg 上限（:36,:168-171） | **GROUNDED / REFERENCE_CLASS 两个新层**（新 provenance + 新 payoff 字段 + 新 optimizer 分支 + UI union/tierLabel/badge） |
| `lib/relate/discover.ts` 的多路 recall：`embed.ts` 语义向量索引（:936）+ `recallCandidatesWithQwen`（LLM 因果 recall，:942）+ lexical，跑在 `sharedUniverse()` 广集上 | KG 接地（CauseNet/ConceptNet 打分）、argumentative-coherence、Dutch-book 检查 |
| `lib/relate/marketIndex.ts` `queryMarketIndex`（**lexical ILIKE 前缀过滤**，加性拓宽宇宙，非语义 kNN） | reference-class 先验构造、经验贝叶斯收缩、semantic-entropy/CoCoA、selective 门、对称/对抗 elicit |
| `lib/relate/tuningProfile.ts` 方向已进 bucket key（LEAF `role|mechType|direction|side`，:61）、`lib/relate/ontology.ts eventDimension`（:90）、`lib/association/elicit.ts` 独立性护栏（:124，脆弱正则） | 外部证据与结算样本的**字段隔离** + "含外部先验⇒永不 CALIBRATED"的结构化不变量 |

```
锚定赌注 B
   │
 ①PROPOSE  场景 schema 展开：跨正交维度枚举因果邻居事件（LLM，盲化用户意图）
   │        → 复用 ontology.eventDimension；输出"事件节点+一句机制"
 ②GROUND   接地：每条 (B↔node) 机制边 → CauseNet/ConceptNet 找支撑边 → grounding score（新）
   │        → 映射到活跃市场：复用 embed.ts 语义索引 + recallCandidatesWithQwen（已能跨维度）
   │           + market_index lexical 加性拓宽；无市场者作解释不成腿（诚实）
 ③BOUND    定界：取两市场边际 → Fréchet 条件窗（复用单向 clamp）
   │        → LLM sign 只在结构单调时挑半窗；否则保留双边窗 + 报原始宽度（§2.5 纪律）
 ④VERIFY   验证：异模型族独立采样定"方向+是否真有机制"（self-consistency / semantic entropy，需先证跨族）
   │        + argumentative-coherence 过滤 + Dutch-book 零数据信号
   │        + 对称双向 elicit 反谄媚（分歧则 ABSTAIN）
 ⑤CALIBRATE 校准：外部 reference-class 先验 → 经验贝叶斯收缩（外部计数写入**独立字段**）
   │        → 真实结算样本累积主导权重才升 CALIBRATED（门槛不动，结构化隔离）
   ▼
 多轴置信 → 价格/EV/流动性门 + GROUNDED abstain 阈值 → protect 腿（反 sign）/ amplify 腿（同 sign）/ abstain
```

### ①PROPOSE — 场景展开（LLM 结构，盲化）
把 B 归一成 `{entity, scenario, outcome}`，让 LLM 枚举**同一场景 schema 的其他槽位**（世界杯：阵容/伤病、教练/战术、个人奖项、小组/淘汰、对手强弱……），每个候选事件配**一句显式机制**，约束 1–2 跳（多跳退化/幻觉）。**prompt 不暴露用户站哪边、不暗示"希望对冲成立"。** 复用 `discover.ts` recall + `ontology.ts eventDimension`（≤1 腿/维度已在）；新增一个"scenario 展开"prompt 变体。**定位（§18 定案后）：scenario 展开是既有单调用 `recallCandidatesWithQwen` 的 prompt 变体——属 §18"KEEP 单调用召回"范围内的升级，不属被推迟的生成式辐射。**

### ②GROUND — 接地 + 映射真实市场（诚实底线）
- **跨维度 recall 已有**（验证补正）：`embed.ts` 语义向量索引 + `recallCandidatesWithQwen`（专打 Fed↔crypto、regime↔oil 这类 lexical/embedding 都漏的非显式机制）已在 `discover.ts` 并行跑，跑在 `sharedUniverse()` 广集上。`market_index`/`queryMarketIndex` 是 **lexical ILIKE 加性拓宽**，不是语义 kNN。
- **接地打分（新）：** 每条 B↔node 机制边去 **CauseNet-Precision（96%）/ ConceptNet API** 找支撑边给 `groundingScore`；纯 LLM 的降级标注。v1 只用这两个免费资源。**"CausalRAG 式 kNN + 因果图边扩展"是全新工作**（要额外 embedding 索引 + KG 遍历），不是复用 market_index。
- **诚实取舍：** 只保留 (a) 与 anchor **不同维度** 且 (b) **有活跃可交易合约**的候选。**无市场的因果因子做成"不可交易的解释对象"（无 side/price、物理上进不了 buildOptimizerCandidates），只解释不成腿**，绝不虚构（honesty backbone "real markets only"）。

### ③BOUND — 价格定界（复用单向 clamp，限制 sign 挑窗）
取两市场 de-vig 边际算 Fréchet 条件窗；**LLM sign 只在结构单调（子集/互斥）时挑半窗并收紧**，因果 sign 不确定时保留双边窗 + 同时报原始宽度（§2.5）。任何 LLM 条件值越 Fréchet 窗 = 幻觉信号，裁掉。候选强度永远是**有界区间，不出裸数字**。

### ④VERIFY — 多轴验证（全部 n=0 可算）
异模型族**独立**采样、semantic-entropy/self-consistency 投票，**只保留方向丢弃大小**（已核实：现链单应答回退、非跨族——M 轴今天不成立，先以对抗框架否决替代，见 §18#3/#4）；argumentative-coherence 过滤；Dutch-book 一致性零数据信号；对称双向 elicit 反谄媚，两轮分歧则 ABSTAIN。**辩论式共识禁用（herding）。**

### ⑤CALIBRATE — 外部先验 + 收缩 + 慢结算升级（结构化隔离）
- 外部 reference-class 先验（多构造取平均，零格 Laplace）→ 经验贝叶斯/分层收缩。
- **诚实红线（验证补正，必须结构化，不能只写文档）：** 外部/先验伪计数**必须存在与"结算样本计数"隔离的字段**里，`sufficientEvidence`（`calibration.ts:135`）与 diag 的 `bucketsAt20PerBranch`（`stats/route.ts`）**只数真实独立结算 episode**；**任何含外部先验贡献的候选，其 provenance 结构上永不能是 `CALIBRATED`**——像 `types.ts:102` 对 `structuralCoverage` 那样加"仅可信来源可设置"的不变量 + 回归测试。
- **代码落点（验证补正）：** ANALYTIC/MODELED 候选由 `discover.ts:873-906 toOptimizerModeledLegs` 产出，在 `discover.ts:1043` 合并成 `[...calibratedCands, ...modeledCands]` 喂给 optimizer；**GROUNDED 最自然在 `toOptimizerModeledLegs`（或兄弟函数）产出并并入该数组**。`optimizer.ts` 是**封闭 if/else 派发**（末尾 :129 拒绝未知 provenance），所以**新层不是"接缝注入"，而是真实引擎改动**：(1) 扩 `AssociationProvenance`（`types.ts:82`）、(2) `OptimizerCandidate` 加 payoff 载体字段、(3) 加专属 optimizer 分支（payoff 推导 + Fréchet clamp + conservatism 遮蔽 + specificity 门）、(4) UI union/tierLabel/badge 同步。

---

## §4 新的多轴置信梯（替换"20 样本硬门"）

把单一"结算计数门"换成**多轴分数 → 分层标注 → 价格/EV/abstain 门**。**S 与 E/M 轴在 n=0 就能算**，所以引擎**现在**就能诚实推荐。

| 层级 | 达成条件 | 需要结算样本 | 现状 |
|---|---|---|---|
| **STRUCTURAL / ANALYTIC**（顶） | 关系逻辑/机械强制（互斥、子集、算术补、Fréchet 端点 + Dutch-book 一致） | 0 | 现 `ANALYTIC` |
| **GROUNDED / 证据接地**（= MODELED + 徽章，**非新 provenance**，见下已定案） | 高 E（论证一致 + KG 接地 + Dutch-book）→ 只收窄 MODELED 区间；M 轴待跨族链后启用；强度被 Fréchet+单调界住 | 0 | **MODELED 元数据** |
| **REFERENCE_CLASS**（新，低于 CALIBRATED） | 有外部 base rate 先验 + 经验贝叶斯收缩；外部计数在**隔离字段**，不进结算门 | 少量(可迁移) | **全新层** |
| **CALIBRATED**（结算证明） | 冻结快照 + 双分支各 ~20 独立**结算**样本 + 保守下界仍正 + 无泄漏 | ~20 | 现 `CALIBRATED`，**门槛+定义一字不改** |
| **MODELED**（原始） | 仅 LLM 假设，未接地/未过多轴 | 0 | 现 `MODELED`，降为"最弱可展示" |
| **ABSTAIN** | 任一门未过 | — | 现 `NO_ACTION` |

**GROUNDED 的抉择（已定案，2026-07-01 终审）：采用推荐项——GROUNDED 不设独立 provenance 层，而是 MODELED 之上的"接地徽章 + 区间收紧元数据"。** 理由：E/M 轴全是 n=0 的模型自信号（KG 是 OOD；且已核实现链为单应答回退、无跨族并行采样 → M 轴今天不成立），单独设层会夸大可信度。落法：像现有 gold-residual `failLower` 收缩（`discover.ts:897/902`）那样，强 E（KG 接地 + 论证一致 + Dutch-book）只**收窄** MODELED 腿的不确定区间并打"接地"徽章；provenance 仍是 MODELED，sizing 权限不高于 MODELED；防洪水靠价格/EV/Fréchet + 每查询硬性条数上限（保形门在 n=0 是空的）。**因此引擎只新增一个 provenance：REFERENCE_CLASS**（真正携带外部证据的层）；HYPOTHESIS 仍是"未接地端"的既有归宿。**全文 §13/§15 等表格中的"GROUNDED"一律按此语义读（= MODELED + 接地收紧徽章）。**

**诚实性总纲**：CALIBRATED 的定义与门槛**一字不改**（结算证明专属），且**结构化隔离**（不是文档承诺）；新层**严格低于** CALIBRATED 并标注"尚未结算证明"。与 memory 2026-06-28 north-star refinement（"moat 训练不 gate，每次查询给当前能力下最佳推荐 + 置信标签"）一致。

---

## §5 诚实护栏（每条对应一个已知失败模式；★=验证新增/加强）

1. ★**反谄媚（升级）**：prompt 盲化用户立场；**对称双向 elicit + 对抗"它不赔"一轮，两轮实质分歧超容差则 ABSTAIN/equalize**；**不靠单条正则**（现 `elicit.ts:124` 会漏"编机制"式谄媚）。加一个用"伪造机制"钓鱼的测试。（46–95% 翻转，非可选）
2. **可迁移性门（transportability）**：外部真实世界 base rate 是**跨总体迁移**到"市场定价"总体（市场**可能**部分 price-in 同类公开信息，从而机制漂移——这是**建模假设**，非已证 EMH 定律）→ 只能进 REFERENCE_CLASS，**结构上永不冒充 CALIBRATED**（Pearl/Bareinboim selection diagram）。
3. **伪相关筛（Google Flu Trends 教训）**：先验**机制先行**（禁 top-k 相关性扫描）+ 跨时间窗稳定；疑似共同季节性/媒体传染驱动的关系打回。
4. **过度收缩护栏（Clemente 问题）**：真正异常的关系允许逃离 pool，宁可加宽区间不过度拉向均值。
5. **方向 token 在 bucket key（F2，已在）**：分层池化会放大坏 key——LEAF `role|mechType|direction|side` 已带 direction，保持；新的外部 bucket 命名空间**不得与结算 leaf rung key 碰撞**。
6. **分布漂移再验证**：CALIBRATED/GROUNDED 周期性 re-validate；regime 变化时用 weighted-conformal **加宽**区间。
7. **"发现 ≠ 可交易"执行门**：逻辑关联后必过流动性/成本/near-touch 执行过滤；无真实市场的因果因子只解释不成腿。
8. ★**联合对冲会计 & soft-leg 上限（验证新增，关键）**：`optimizer.ts:36` `maxSoftLegs=maxCalibratedSoftLegs??1`、:168-171 拒绝第 2 条 soft 腿——因为无 copula 时两条相关 soft 腿的联合下界是 `max_i(reduction_i)`（第 2 条可能 0 增益），加性会计会**高估 sizing**。所以 GROUNDED/MODELED 都是 soft，**至多 1 条**；"多个对冲"= 多条 ANALYTIC 结构腿 + ≤1 soft 因果腿。要真堆多条因果腿，须先建 Fréchet-safe 联合模型（joint calibration，见 settlement-moat 文档 Phase 4-5）。**（§17 细化：上限=每结构互斥格 ≤1 条 elicited soft 腿；ANALYTIC 互斥证明是 joint calibration 之外的第二条合法通路。）**
9. ★**子集腿抬高 strict worst-case（验证新增）**：ANALYTIC 子集 YES 腿（如"欧洲夺冠"）在某些 anchor-fail 子态可能 0 赔付，其保费会**抬高 strict worst-case loss**（`optimizer.ts:188-189`）——必须与 modeled 收益分开如实展示，不能只报好处。
10. **只出有界区间，绝不出裸 LLM 概率**；数值只能被数据收紧、不能被 LLM 放大。EV ≤ market、de-vig、near-touch、NO_GO/ABSTAIN 一等公民不变；L2/L3 法律门保持。

---

## §6 端到端范例："西班牙无法赢得世界杯冠军"

锚定 B = **"Spain will NOT win the WC"**。B **失败** = **西班牙夺冠**。**对冲腿 = 在"西班牙夺冠"状态赔付的市场**（sign 与"西班牙夺冠"同号）。

**①PROPOSE** LLM 展开跨维度因果邻居（不暴露用户立场）：主力伤病、教练变动、金靴、小组头名/晋级、洲际冠军、对手夺冠……

**②GROUND + 映射市场**：
- "西班牙夺冠 ⊆ 欧洲夺冠" → 有"which continent wins"合约 ✅（**同维度子集**，非跨维度）
- "西班牙夺冠 ⊆ 西班牙进决赛" → **注意：当前引擎并不生成此腿**。`structuralCompanions.ts` 只映射了**洲际**子集/rival，**未做"晋级阶段"成员表**（memory BUILD 2 明确"reach final 的 inverted-containment 腿 DEFERRED，需要赛程模拟"）。要它成腿需**新增 stage-progression 成员表**，否则从范例里去掉。
- "西班牙球员金靴" → **GROUNDED 单条 soft 腿**（因果：夺冠球队更可能出金靴；KG 接地 + 异族一致 + Fréchet 界），有界区间。**这是本例真正的跨维度差异点。**
- "西班牙主力受伤""西班牙换帅" → **通常无可交易合约** → 作解释不成腿（不虚构）。

**③BOUND + ④VERIFY（关键的方向纠正，诚实教学点）**：
- **主力受伤 / 换帅**：与"西班牙夺冠"**负相关** → 在 **B 获胜**（西班牙夺不了冠）状态赔付 → 对"B 不夺冠"这个赌注它们是**放大器（amplify），不是对冲**。用户的例子方向是反的（owner 已注"例子不一定准确"），引擎会**正确定号**并归入 amplify 侧。
- **真正的对冲腿**（在西班牙夺冠状态赔付）：
  - **"欧洲夺冠" YES** — ANALYTIC 子集，走**结构路径**（`discover.ts:889` structuralPayoff → `optimizer.ts:54`），**不是** `toOptimizerCandidates` 跨事件路径（后者 :124 会丢弃 same-entity 腿）。但注意它是**同维度**子集，且**抬高 strict worst-case**（§5 护栏 9）。
  - **"西班牙球员金靴" YES** — GROUNDED 的**那 1 条 soft 因果腿**（受 soft 上限约束）。

**⑤路由**：protect 方向选反 sign 的对冲腿；amplify 方向（超激进）才用同 B 的主力伤/换帅这类。**同一套发现，双向复用**——正是 memory 里 bipolar superposition 滑块（左 protect / 右 amplify）。

> 两点结论：**(1) 方向（sign）是枢纽，也恰是 LLM 最可靠输出——本例 sign 推导经独立核实完全正确。(2) 诚实的真相是：结构子集腿多是"同维度"、跨维度可交易腿往往只有 0–1 条**（金靴这种）。所以对多数 anchor，产品价值更像"讲清因果版图 + 偶尔一条跨市场腿"，而非"每次给一把跨维度对冲"——这需要 §7 的实测来定性。

---

## §7 分阶段落地（先不改代码，这是路线）+ 不变量

> **时序以 §18/§19 为准（2026-07-01 终审）：Gate 0 = Phase-1.5 命中率实测先行；两条 HIGH 主线 = GIN 索引与 ANALYTIC 泛化；KG 接地与生成式 WALK 推迟。本节 Phase 编号仅作内容分组，不再是执行顺序。**

**Phase 0（改 prompt / 加门，最小引擎改动）**：① scenario 展开 prompt + 反谄媚盲化 + 对称/对抗 elicit + 分歧 ABSTAIN；③ 把 Fréchet 单向 clamp 前置（限制 sign 挑窗）；④ 反谄媚"对抗框架否决"（两次 temp-0 换框架、sign 不一致即 ABSTAIN；现链单应答回退、非跨族——§18#3 已核实，真 self-consistency 需先加非 Qwen 模型并行采样）。
> **诚实提醒**：即便 Phase 0，要让 GROUNDED 真正"能被推荐"，仍需 §3 末列的引擎改动（扩 provenance union + 加 payoff 字段 + 加 optimizer 分支 + UI）——这**不是纯 prompt 活**。

**Phase 1（接免费外部资源）**：② CauseNet-Precision（135MB 可下载）+ ConceptNet API 接地打分；⑤ 为**高频 bucket** 半自动构造 reference-class 先验 + 经验贝叶斯收缩 → REFERENCE_CLASS（外部计数写隔离字段）。
> **诚实提醒**：reference-class 先验是**按 bucket 的人工/半自动劳动 + 每 bucket 的可迁移性人判**，只覆盖**高频头部**；新颖/长尾 pair **落回 GROUNDED/MODELED（n=0 层），不进 REFERENCE_CLASS**。所以这是把冷启动瓶颈从"等结算"**部分转移**到"构造参照类"，不是凭空消除。需披露覆盖头部占实际查询的比例。

**Phase 1.5（先做的实测——决定产品成色）**：抽 N 个真实 anchor，枚举因果邻居，统计**多少能落到 Polymarket/Kalshi 真实活跃合约**、其中**跨维度**（非同维度子集）的中位数条数。若中位数 0–1，就把价值主张定为"讲清因果版图 + 偶尔跨市场腿"，别宣传"每次一把跨维度对冲"。

**Phase 2（升级）**：ASER/COMET 提事件级 recall；conformal 覆盖误差棒；weighted-conformal 抗漂移；异族 LLM-judge；combo 联合校准（joint）按 settlement-moat 文档 Phase 4-5 慢积累（也是解 soft-leg 上限的正道）。

**永不改的不变量（honesty backbone）**：CALIBRATED 仍只来自真实结算、门槛+定义不动、**结构化隔离**；real markets only（无合约的因子只解释不成腿，做成不可交易对象）；EV ≤ market、de-vig、near-touch、NO_GO/ABSTAIN 一等公民；只出有界区间不出裸 LLM 数字；L2/L3 法律门保持。

---

## §8 数据依赖到底降了多少（量化 + caveat）

- **发现**：本来就不靠结算（LLM + embed + recall + market_index），维持。
- **敢不敢推荐**：从"必须 20 个结算样本"→ **S/E 轴 n=0 可推荐**（诚实标注"MODELED+接地徽章"；M 轴待跨族链；**每结构互斥格 ≤1 条 soft 因果腿**（§17）+ 多条结构腿），结算只把某类升到"已证明"。
- **条件强度校准**：LLM 建 BN 实验示例 **3 真实样本 + 先验 > 纯 30 样本**（离散 BN/≤5 父/同域/中位数 KL，迁移未验证）；REFERENCE_CLASS 让**高频头部** bucket day-1 有历史信号，**长尾落回 n=0 层**。
- **净效果**：把"4 年等一届世界杯"的冷启动，换成**即时可用、诚实标注、随真实结算单调收紧收敛到结算真值**的推荐——**在不重造 moat 那件人造物的前提下**降低对慢结算数据的依赖。但要如实说：**降低≠消除**，且产品成色取决于 §7 的跨维度可交易腿命中率。

---

## §9 参考文献（一手）

**LLM 预测/校准**：Halawi et al. NeurIPS 2024 https://arxiv.org/abs/2402.18563 · AIA Forecaster 2025 https://arxiv.org/html/2511.07678v1 · ForecastBench https://www.forecastbench.org/ · Wisdom of Silicon Crowd https://pmc.ncbi.nlm.nih.gov/articles/PMC11800985/ · Mind the Confidence Gap https://arxiv.org/html/2502.11028v3 · **SycEval（谄媚 46–95%）https://arxiv.org/abs/2502.08177** · ELEPHANT（社交谄媚）https://arxiv.org/html/2505.13995v2 · Reasoning Under Uncertainty https://arxiv.org/abs/2509.10739 · Always Tell Me The Odds https://arxiv.org/pdf/2505.01595

**因果知识图 + LLM 因果推理**：CauseNet https://causenet.org/ · COMET-ATOMIC2020 https://arxiv.org/abs/2010.05953 · ASER https://arxiv.org/abs/2104.02137 · ConceptNet https://arxiv.org/pdf/1612.03975 · Corr2Cause https://arxiv.org/html/2306.05836v2 · CLadder https://arxiv.org/html/2312.04350v3 · Causal Parrots https://arxiv.org/abs/2308.13067 · CausalRAG https://arxiv.org/abs/2503.19878 · Schema Induction https://arxiv.org/pdf/2307.01972

**市场关联发现现状**：Semantic Trading（Columbia/IBM 2025）https://arxiv.org/html/2512.02436v1 · Probabilistic Forest（IMDEA/Oxford 2025）https://arxiv.org/html/2508.03474v1 · Law of One Price（TUM 2025）https://arxiv.org/html/2601.01706v1 · Consistency Checks（ETH, ICLR 2025）https://arxiv.org/abs/2412.18544 · 62%-fail（小样本博客，n=13）https://medium.com/@navnoorbawa/combinatorial-arbitrage-in-prediction-markets-why-62-of-llm-detected-dependencies-fail-to-26f614804e8d · LMSR/MILP arbitrage-free http://www.columbia.edu/~ck2945/papers/milp_market.pdf

**外部数据代理校准**：Reference class forecasting https://en.wikipedia.org/wiki/Reference_class_forecasting · Efron CASI Ch.7（James–Stein）https://efron.ckirby.su.domains/other/CASI_Chap7_Nov2014.pdf · Covariate-Powered EB https://arxiv.org/pdf/1906.01611 · Clemente Problem https://arxiv.org/pdf/2506.10114 · Google Flu Trends https://arxiv.org/abs/1408.0699 · Transportability（Bareinboim & Pearl）https://arxiv.org/pdf/1503.01603 · RoPE misspecification https://arxiv.org/abs/2405.08719

**LLM 建因果图/SCM + 定界**：Kıcıman et al. 2023 https://arxiv.org/abs/2305.00050 · Causal Order https://arxiv.org/abs/2310.15117 · LLM priors for causal discovery https://arxiv.org/abs/2405.13551 · **LLM→BN CPT（3 样本>30，§6.7）https://arxiv.org/html/2505.15918v1** · LLM priors 少样本 https://arxiv.org/html/2509.04250v2 · Fréchet Inequalities（Pearl）https://causality.cs.ucla.edu/blog/index.php/2019/11/05/frechet-inequalities/ · 单调性 sharp bounds https://www.mdpi.com/2227-7390/13/19/3103 · Verbalized prob 校准 https://arxiv.org/html/2410.06707v1

**无标注置信度**：Semantic Entropy（Nature 2024）https://arxiv.org/abs/2406.15927 · CoCoA https://arxiv.org/html/2502.04964v5 · Can LLM Agents Really Debate（herding）https://arxiv.org/pdf/2511.07784 · Conformal Gentle Intro https://arxiv.org/html/2107.07511v6 · Rule of three https://en.wikipedia.org/wiki/Rule_of_three_(statistics) · Selective Conformal Risk Control https://arxiv.org/html/2512.12844 · Argumentative Coherence（Gorur 2025）https://arxiv.org/abs/2507.23163

---

## §10 对抗验证记录（8-agent workflow，2026-07-01）

本方案初稿经 **4 视角批判（诚实底线 / 代码可行性 / 研究保真 / 产品痛点）→ 逐条独立核实（CONFIRMED/PLAUSIBLE/REFUTED）**。27 条发现，24 条确认/可信（已折入上文），3 条被驳回（反而加固了方案）。

**已修正的确认项（本稿已改）：**
- **[HIGH]** 删除"不重写引擎/复用 CALIBRATED 校准槽"的错误框架 → §3/§4/§5 明确：新层需扩 provenance union + 加 payoff 字段 + 加 optimizer 分支 + UI，且外部计数**结构化隔离**、"含外部先验⇒永不 CALIBRATED"。
- **[HIGH]** 修正代码落点：真实合并点 `discover.ts:1043`，ANALYTIC/MODELED 产出在 `toOptimizerModeledLegs`（:873-906），optimizer 是封闭派发（:129 末尾拒绝）。
- **[MED]** 补 soft-leg 上限（§5 护栏 8）→ "多个对冲"缩为"多结构腿 + ≤1 soft 因果腿"。
- **[MED]** §6 子集腿走结构路径、"进决赛"当前未生成、子集腿抬高 strict worst-case。
- **[MED]** ③ Fréchet 用 LLM sign 挑半窗的诚实风险（§2.5 纪律）。
- **[MED]** GROUNDED 是否该高于 MODELED 的诚实抉择 + n=0 保形门为空 → 靠价格/EV/条数上限防洪水（§4）。
- **[MED]** 数据订正：73%→51%（同指标）；谄媚 46–95% 应引 SycEval 2502.08177；62% 系小样本博客（n=13）。
- **[MED]** GROUND recall 归因订正：跨维度 recall 由 embed.ts + recallCandidatesWithQwen 承担，market_index 是 lexical 加性拓宽；CausalRAG kNN 是全新工作。
- **[LOW]** 路径前缀（`lib/association/optimizer.ts`、`lib/association/elicit.ts`）、无市场因子做成不可交易对象、"已有 vs 全新"清单、reference-class 人工成本与覆盖头/尾、CPT 30–100 caveat、"市场 price-in"降级为建模假设。

**被驳回（核实后确认方案本就正确）：**
- "3 样本≈30 纯数据"**是** arxiv 2505.15918 §6.7 原文示例，非杜撰。
- 代码锚点**未**过时（`tuningProfile.ts` 在 `lib/relate/`，文档未误写路径）。
- **embeddings 语义检索已存在**（`embed.ts` + `recallCandidatesWithQwen`），跨维度 recall 非"lexical-only 结构性失败"；仅 market_index 那句 CausalRAG 归因需订正。
- §6 的 **sign 推导完全正确**（Europe/进决赛/金靴=对冲，伤病/换帅=放大器），无需改。

---

# 第二部分：发现内核的深化 —— 复刻人类联想思维链，做成域无关强泛化引擎

> 追加于 2026-07-01（第二轮研究 + 验证）。目标：把上文 `①PROPOSE`（原来偏机械的"让 LLM 展开"）升级成**对人类专家"从一个赌注 → 相关事件网"的联想思维链的严谨复刻**，且**结构上独立于任何具体域**（西班牙世界杯只是一个切片）。研究线：专家联想/情报分析结构化技术、域无关关系分类学、反锚定与覆盖度量。核心库文件已核对（`lib/association/types.ts` 已有 `MechanismType`/`MechanismScope` 枚举、`qwen.ts` 已有 `relation`/`mechanismGraph`/`sharedDrivers`），所以这是**精炼既有本体 + 补上"系统性走法"**，不是另起炉灶。

## §11 泛化的第一性原理：不变的推理骨架 × 可变的域内容

**强泛化的唯一来源 = 把"不变的推理结构"与"可变的域知识"彻底分离。**

- **不变（引擎硬编码）：** 一套固定的**关系算子本体**（两个事件之间能有的所有关系类型）+ 一套固定的**联想 walk 程序** + 固定的**去偏/覆盖机制**。对 Fed 决议、Trump 当选、BTC>10万、Nvidia 财报、以巴停火、西班牙夺冠——**跑的是同一套算子和同一套 walk**。
- **可变（LLM + KG + market_index 填充）：** 每个算子在具体锚定上指向什么事件、什么市场。域知识只是"填空"。

这直接回答"不要被例子局限"：**引擎里唯一固定的东西是算子集和走法，域内容一律外部供给**。研究实证支撑（vein 反锚定）：单条自由 prompt 必塌缩到显而易见的少数，任何具体例子都在早期 detokenization 阶段锚定模型——**广度必须"结构化地工程进去"**，靠算子本体保证，而不是靠 prompt 措辞。

**专家的联想是一个两阶段引擎（vein 专家思维链）：**
1. **GENERATE（发散·求覆盖）**：沿固定算子/类别筛全面辐射，宁滥勿缺。
2. **RANK/PRUNE（收敛·求区分度）**：按解释力/可诊断性打分，**DISPROVE-TO-SURVIVE**（留矛盾最少者，不留支持最多者——这一步同时就是**反谄媚**）。

## §12 Step 0：把任意赌注操作化成 6 槽事件框架（让两个市场可比）

算子作用在"事件"上，但市场是一句话。任何算子生效前，先把 **anchor 与 candidate 都**分解成同一个结构签名（FrameNet 式"谁对谁做了什么"+ 结算机制）：

| 槽 | 含义 | 决定什么 |
|---|---|---|
| **Entity** 实体 | 市场追踪的对象（人/国/资产/公司/队/指标）；归一别名 | 触发 Equivalence 去重、SAME_ENTITY vs CROSS_ENTITY 作用域 |
| **Event-frame** 事件框架 | FrameNet 场景类型：`Change_position_on_a_scale`（价/率过线）/`Win_prize`（单胜者场）/`Occurrence`（离散发生）/`Reporting`（权威宣布） | 决定哪一**组**算子可用（选举框架⇒分区算子；报道框架⇒代理算子） |
| **Metric** 指标 | 被测量（价/数/是否/差值） | 两市场只能在共享指标或指标映射上逻辑相关 |
| **Threshold** 阈值 | 精确结算切点（≥$X、>Y%、"过半"） | **同指标不同阈值⇒蕴含/子集关系(III-2)的发生器** |
| **Time** 时间 | 结算时刻 + 观测窗 | 决定时间修饰(Group V) → 领先/同步/滞后 → **可交易性** |
| **Resolution-source** 结算源 | 判定的权威/数据源 | 共享源触发**相关失效陷阱(VI-3)**；区分代理(VI-1)与本体 |

对应现有代码：`lib/relate/normalize.ts`（→NormalizedMarket）+ `classify.ts` 已部分做实体/事件类抽取；本方案是把它**显式补全成 6 槽**，作为算子分配的前置。

## §13 通用关系算子本体（近 MECE，映射到现有枚举 + 置信层 + 界）

约定：**A=anchor，B=candidate**。**sign 列是"边-相对"的——指该算子实际提议的那条可交易腿(YES 或 NO)与 anchor 的相关方向,按构造:HEDGE 腿永远对 anchor 为负号(在 anchor 失败态赔付),AMPLIFIER 腿为正号。** 注意 ENABLE/蕴含/PREVENT 这类:被描述的 YES 实体可能与 anchor **正**相关(如"前置条件成立"与 anchor 成功同现),但可交易的对冲腿是它的**否定/NO**;表里 role=HEDGE 指的就是那条 NO 腿,其 sign 已按 NO 腿记为负。这与引擎 `tuningProfile.ts:61` 的 `role|mechType|direction|side` bucket key **同时带 direction 与 side** 一致。这张表就是"人类遇到赌注时能联想到的所有关系类型"的**穷举**——每种联想都落在其中一行。

| # | 算子（人类联想动作） | 现有引擎枚举 | 默认 sign | 对冲/放大 | 置信层 | 强度界（关键） |
|---|---|---|---|---|---|---|
| **逻辑/集合（最紧、最可交易）** ||||||
| L1 | 等价/同一（同一事件换说法） | `EQUIVALENT`/IDENTITY | +1 | 仅去重/跨场套利 | ANALYTIC | Corr=+1（上 Fréchet） |
| L2 | 蕴含/子集 A⇒B（窄⇒宽） | `IMPLICATION` | + | B 放大 A；**¬B⇒¬A 是对冲腿** | ANALYTIC | Fréchet 端点，P(A∧B)=P(A) |
| L3 | 互斥 A∧B=∅ | `MUTEX` | − | **HEDGE**（除非穷尽否则不完整） | ANALYTIC | Fréchet 下界 |
| L4 | 分区/单胜者场（互斥且穷尽） | `MUTEX`+exhaustive | − | **HEDGE（补集=金标准对冲几何）** | ANALYTIC | ΣP=1 单纯形约束；防"其他/none"泄漏 |
| L5 | 部分重叠（互不含） | `THEMATIC`/partial | 弱 + | 弱放大 | GROUNDED | 严格在 Fréchet 内，须估 |
| **力动态因果（有向、带符号）** ||||||
| C1 | CAUSE/产生（A 主动致 B） | `CAUSAL` edge=CAUSES | + | 放大 | GROUNDED | 有向边最强，仍<1 |
| C2 | **ENABLE/前置条件（B 需要 A）** | `CAUSAL`/`LOGICAL`（ATOMIC xNeed/HasPrerequisite） | + 非对称 | **最佳因果 HEDGE：¬A⇒¬B 近逻辑** | GROUNDED→近 ANALYTIC | P(B)≤P(A)；¬A→¬B 紧、A→B 松 |
| C3 | PREVENT/抑制（A 阻止 B） | `CAUSAL` NEGATIVE | − | **HEDGE** | GROUNDED | 与 CAUSE 对称取负 |
| C4 | MOTIVATE/激励（A 给 agent 动机做 B） | `BEHAVIORAL`/`INSTITUTIONAL` | 弱 + | 放大，低信 | MODELED | 经自由 agent 选择，封顶低、随 regime 变 |
| **Pearl 结（结构原子）** ||||||
| P1 | **共同原因/Fork A←Z→B（跨维度矿脉）** | `COMMON_CAUSE` + `sharedDrivers` | Z 两臂同向 + / 反向 − | **反向 = 跨域 HEDGE** | GROUNDED | ≤ 较弱那条臂；**条件于 Z 不变（regime 脆）** |
| P2 | 链/中介 A→M→B | `CAUSAL` 链 | + 衰减 | 放大 | MODELED | 每跳 ×(0,1) 递减；长链弱 |
| P3 | **对撞/Collider A→E←B（陷阱）** | —— | ≈0 边际 | **否决（Berkson）** | REJECT | 边际≈0；若市场宇宙按共同结果**选择**则伪负相关 |
| **代理/叙事（可靠性封顶）** ||||||
| N1 | 代理/指标（B 不完美测 A） | `INFORMATION` | + | 弱放大/弱对冲 | SPECULATIVE | **Corr ≤ √reliability**（测量误差衰减） |
| N2 | 叙事/感知（B 追 A 的媒体框架） | `NARRATIVE` | 平时 +，冲击时→0/翻转 | 不可靠 | SPECULATIVE（不 sizing） | **恰在需要对冲的尾部 regime 解耦** |
| N3 | 共享结算源/定义 | —— | 源诱导 + | **相关失效陷阱** | REJECT | 共源风险不可分散，尾部同时失效 |
| **部分-整体/替代** ||||||
| W1 | 部分→整体（B 是 A 所属总量/指数） | `LOGICAL`/`IMPLICATION` | + 按权重 | 放大 | ANALYTIC/GROUNDED | ≤ A 在整体中的份额 |
| W2 | 替代/竞争（争同一 slot/预算/需求） | `ECONOMIC` | − | **HEDGE** | GROUNDED | 随可替代性增强，极限=互斥 L3 |
| W3 | 互补（捆绑同现） | `ECONOMIC` | + | 放大 | GROUNDED | 若有共享驱动则实为 Fork P1，先排除混淆 |

**表内置信标签 ↔ 引擎枚举（终审映射）：** GROUNDED = MODELED + 接地收紧徽章（§4 已定案，非新 provenance）；SPECULATIVE = 既有 `HYPOTHESIS`（仅展示、永不进 payoff，`toOptimizerCandidates.ts:180`）；REJECT = Group-IV 否决 → ABSTAIN/NO_ACTION（不是 provenance 值）。唯一新 provenance = REFERENCE_CLASS。

**时间修饰（Group V，正交叠加，管"可交易性"不管 sign）：** 领先（B 先结算）=可带前置期主动对冲（最佳）；同步=组合对冲无信号；**滞后（B 后结算）=不能保护 anchor 决策，主动用降级**。

**偏差否决（Group IV，是否决不是关系）：** 混淆（regime 脆，打折信心）；调节/moderation（**第三变量能翻 sign——绝不脱离 regime 存 sign**）；反向因果（sign 同、时序与条件反转）；选择/collider（否决）；伪相关（**每个发现的默认零假设——必须先有 Group I–III 的结构故事才可信**）。

**给用户目标的三条落点：**
- **"跨维度"= CROSS_ENTITY/CROSS_DOMAIN 作用域**，最富矿脉是 **P1 共同原因/fork**（一个宏观/地缘共同驱动伸进完全不同的市场类别）+ C1/C3 下游因果 + W2 替代。
- **最佳对冲排序：** L4 分区 > L3 互斥 > **C2 前置条件(¬A⇒¬B)** > C3 抑制 > P1 反向 fork > W2 替代。**最佳放大：** L2 蕴含、C1 因果、W1 部分-整体。
- **你的西班牙例子精确归位：** "主力受伤/换帅"= **C3 PREVENT（对'西班牙夺冠'）/ 对'西班牙夺不了冠'这个赌注是同向放大器**；真正对冲是 L2 子集（欧洲夺冠/进决赛）+ P1/C1（金靴）。一个例子只覆盖了本体的极小一角——这正说明**必须靠整张算子表系统性地走，而不是顺着例子的方向想**。

## §14 双向 WALK + 反锚定覆盖（GENERATE 阶段的具体走法）

> **§18#2 定案（2026-07-01 终审）：本节的生成式逐算子辐射（WALK-A）与生成式 pre-mortem（WALK-B）整体 DEFER——广度不是当前瓶颈，等 Phase-1.5 需求信号。当前只落地两件确定性 fail-closed 件：N3/P3 图拒绝 + 对 §13 算子表的覆盖记账；召回保持单调用。本节保留为 deferred 设计参考。**

人类不是自由联想，而是**沿两条互补的链系统辐射**。引擎照搬：

### WALK-A：关系辐射（找全部相关市场，hedge + amplifier 都要）
1. **抽象种子**：先把 anchor 抽象成 6 槽结构签名，**推迟具体域进入**（反锚定根治手段）。
2. **taxonomy-first + 逐算子强制覆盖**：先让模型输出"关系维度清单"（就是 §13 那张表），再**遍历每一行算子，要求"≥1 候选，否则显式 NONE + 理由"**——把广度变成结构保证（实证：注入候选关系类型使覆盖 44%→69%）。
3. **PESTLE-M 类别筛**：沿 政治/经济/社会/科技/法律/环境/军事 七通道各扫**原因与后果**——保证跨域触达，任何锚定都跑同一张筛。
4. **verbalized sampling + 自由文本枚举**：要"k 候选 + 概率分布"而非单最优；**先自由文本枚举再格式化**（结构化 JSON 输出本身压缩多样性）。
5. **过采样后 DPP 多样性选择**：嵌入空间体积最大化选子集，而非截 top-k（截断会重新塌回显而易见的几个）。

### WALK-B：失败情景反推（pre-mortem，专产对冲——这正是你说的"反向推理"）
1. **前瞻性后见（prospective hindsight）**："假设 anchor 已经失败了，复盘它是怎么失败的"——比"它会不会失败"能多列出 ~30% 的原因（Klein/Kahneman）。
2. **VARY-ONE-DRIVER（可能性锥）**：每次翻转一个关键驱动假设，扇出**互斥的失败子态** + 低概率高冲击 wildcard。
3. 对**每个失败子态**找一个"在该子态为真"的市场 → 它们就是**在你需要时赔付的对冲**。
4. 失败子态天然**分区** → 直接得到"哪些失败态被覆盖、哪些仍裸露"——接上引擎 `/protect` 面（`app/protect`）"裸露失败态诚实展示"的既有理念（注：`lib/hedge/protect.ts` 已不在，展示逻辑在 protect 面 + 优化器的 `strictWorstLoss`/uncovered 会计）。

### RANK/PRUNE（两条 walk 的产出汇入，收敛）
接 §3 的 GROUND→BOUND→VERIFY→CALIBRATE，但 VERIFY 用专家的收敛纪律加强：**diagnosticity-first**（只留能区分假设的候选）、**DISPROVE-TO-SURVIVE**（对每个候选独立跑"论证它不赔"一轮，留矛盾最少者——同时是反谄媚）、explanatory-virtue 打分（scope/unification/mechanism/non-ad-hoc）、Dutch-book 一致性（零数据 ANALYTIC 信号）。

### 反锚定 / 去偏护栏（工程化，vein 实证）
- **abstract-the-seed**（结构签名再特化）+ **taxonomy-first**（先生成维度再填）+ **逐算子强制 ≥1/NONE**（结构覆盖）+ **decouple format**（先文本后 JSON）+ **DPP 选择**（防塌缩）+ **persona 轮换/avoid-repetition**。
- **完备性去偏**：GENERATE-A-SET（评估前先凑≥3–5）、**PROBE-THE-PRUNED-BRANCH**（每次问"我漏了哪整类算子/哪个 PESTLE 通道"，破 Fischhoff 故障树错觉）、COMPLETE-THEN-ELIMINATE（穷举后再淘汰）。

映射现有代码：这套 WALK 落在 `lib/relate/discover.ts` 的 recall 阶段之前/之内（现有 recall = embed + `recallCandidatesWithQwen` + lexical，是"相似度驱动"，**不保证逐算子覆盖**）——WALK 用"算子清单 + PESTLE 筛"把它从"相似度召回"升级成"结构化穷举召回"。`mechanismGraph.sharedDrivers`（已存在）正是 P1 fork 的载体，但目前没有被**系统性地走**，这是最大的未采矿脉。

**算子 ↔ 引擎既有 mechanismGraph 边类型（`lib/association/types.ts:19`，验证补正——比预想更全）：** `MechanismEdgeKind = CAUSES | ENABLES | INHIBITS | SIGNALS | REACTS_TO | SHARES_DRIVER | RESOLVES_WITH | IMPLIES`，几乎与 §13 算子一一对应：**ENABLES=C2、INHIBITS=C3、CAUSES=C1、SHARES_DRIVER=P1 fork、SIGNALS=N1 代理、RESOLVES_WITH=N3 共享源、IMPLIES=L2 蕴含、REACTS_TO=反馈**。所以算子本体**能被现有图结构表达**（"精炼而非重写"更硬）。**但两个关键陷阱没有被消费**：`RESOLVES_WITH`（N3 共享结算源）边虽可表达却**无任何代码据此自动拒腿**；**P3 collider 是图拓扑 A→E←B（不是单条边），既无枚举也无检测**——所以 §13 里 N3/P3 的拒绝目前是**纯 prompt 保证、零代码强制**（§2.6 已述 n=0 保形门为空,无结构兜底）。要真正防这两个陷阱，需新增"按 RESOLVES_WITH 边 / collider 拓扑自动排除候选"的代码。另：provenance 实为 **4 值**（`types.ts:82`：`ANALYTIC|CALIBRATED|MODELED|HYPOTHESIS`），`HYPOTHESIS` 是**已存在的"仅 LLM、永不进 payoff、仅展示"最底层**（`toOptimizerCandidates.ts:180`，≤8 条）——终审定案（§4）：唯一新 provenance 是 REFERENCE_CLASS（插在 MODELED 与 CALIBRATED 之间）；GROUNDED 不设层、落为 MODELED 上的接地收紧徽章；HYPOTHESIS 仍是"未接地那一端"的既有归宿——新增 provenance 面最小化。

## §14.1 可编码的 8 步算法（专家思维链的落地形式）

> **同上（§18#2 定案）：本算法作为 deferred 设计参考保留；先行落地的只有其第 4 步的确定性拒绝（N3/P3）与第 7-8 步的记账/剪枝思想。**

综合情报分析 SAT 全套（Heuer ACH、Glenn Futures Wheel v2、Zwicky 形态学 + Cross-Consistency、Heuer-Pherson Key-Assumptions/What-If/Cross-Impact/Indicators、Klein pre-mortem、Tetlock Fermi-ize + reference class）+ 2025 的 FinRipple（有向关系型金融知识图、有向 hedge=−/amplify=+ 边、多跳扩散）。伪码：

```
输入：claim X（原文）
1. FRAME(X)：解析 6 槽 {who,what,when,where,how_much,mechanism}；
   扰动每个原子 → 变体候选市场（同实体不同阈值 / 同事件不同截止 / 同机制不同场）。   # 操作化
2. FERMIIZE(X)：拆成子事件 S={s1..sk}，f(S)⇒X；每个子事件本身可对冲。               # Tetlock 分解
3. 建 X 的局部因果图：
   parents  P = 上游(驱动/使能/前置)                      # 5-Whys 外扇
   children C = FUTURES_WHEEL(X, depth=3)                 # 1/2/3 阶后果
   给 P∪C 每个节点打 STEEP/PESTEL 维度标签；               # 广度
   若任一维度为空 → 打回重扫该维度。                        [反可得性护栏]
4. 关系变换（对 X 及显著节点，各吐有向 typed 边）：
   FORK→共因兄弟(相关) · RIVALS→MECE 替代集(互斥/反) · CONTAINMENT→子集⇒X⇒超集(蕴含)
   PARTWHOLE→聚合↑/成分↓(求和) · PROXY→同动/叙事领先(信息) · FEEDBACK→自反 R/B 环
   # 每条边带 {type, polarity(hedge=−/amplify=+), strength} —— 即 §13 算子表。
5. 压力扇出（析取覆盖）：
   FAIL = PREMORTEM(X)：枚举互斥失败路径 → 各配一个市场。          # 反向链，专产对冲
   WIN  = PREPARADE(X)：枚举超预期路径 → 放大器。
   ASSUMP = KEY_ASSUMPTIONS(X)：每个假设 → 反向市场 + tripwire。
   TAIL = WHATIF(¬X 高冲击)：回溯 → 尾部关联市场。
6. 去偏门：要求 |RIVALS|≥2 且每节点至少一个反证市场[定势/确认]；给每节点挂 reference-class base rate[锚定]。
7. 可交易过滤(INDICATORS)：只留能映射到"可结算、可观测、最好已被市场定价"信号的节点。
8. 打分剪枝(Cross-Impact + Cross-Consistency)：
   对幸存者建 cross-impact 矩阵 → 估 pairwise Δprob(sign+strength)；
   多腿组合跑 CROSS-CONSISTENCY：删逻辑矛盾/冗余(被 containment 收缩)的腿组合；
   按 {diagnosticity, edge strength, 维度正交性} 排序。
输出：关系市场网，每个带 {relation_type, polarity(hedge|amplify), strength, base_rate, indicator, STEEP 维度}
```

**四个落地要点：** (a) 第 4 步关系变换是**域无关可复用内核**——纯图操作，与主题无关；(b) **STEEP/PESTEL 打标 + 空维度打回**是最重要的广度护栏（把反可得性机制化）；(c) **diagnosticity(ACH) + 维度正交性(Zwicky)** 是让组合腿既有信息量又不冗余的两个排序信号——**正好对应引擎已有的 `eventDimension`（≤1 腿/维度）+ `comboOverlap.ts`**；(d) **pre-mortem 的互斥失败分解**是把"对冲 X 失败"从一团模糊变成一组近正交、各自可交易的失败市场——对对冲引擎价值最高的一步。

**先例（不是从零发明）：** FinRipple（arxiv 2505.23826, 2025）已把"事件 → 有向关系型知识图（领导/交叉持股/专利/供应链边，带合作 vs 竞争符号）→ 多跳扩散 → 按冲击幅度排序"做成系统——正是第 4 步的计算版，可参考其图构建与传播。Cross-Impact 矩阵是 pairwise sign/strength 的经典生成器；Zwicky 盒 + Cross-Consistency 是"正交维度枚举 + 剪不一致腿"的经典方法，与本产品的多腿组合设计天然同构。

## §15 跨 6 域实测（证明骨架不被任何单一例子局限）

**方法**：把 §12–§14.1 的整套程序，原样跑在 6 个**刻意避开体育**、彼此迥异的锚定上（8-agent workflow，每域一个 agent 独立产出完整关系链，再由泛化审计员 + 独立核实）。**结论：`generalizes = true`——同一套算子骨架在全部 6 域上无任何域专属 hack，算子覆盖 ~0.9–1.0，每域都识别出同样的结构陷阱(P3/N3)、都找到 ≥1 条跨维度 soft 对冲。** 各域最强对冲(ANALYTIC 结构腿 + 那条跨维度差异腿)：

| 域 | 锚定 B | 最强 ANALYTIC 对冲(结构、免数据) | 跨维度差异腿(GROUNDED soft，≤1 条) |
|---|---|---|---|
| 宏观利率 | Fed 下次会议**不**降息 | L3/L4：买 Kalshi FOMC 决议 {降息} 子分区(补集,完整同维对冲) | **C2**：失业率升/NFP 走弱 YES(降息的**前置条件**,¬弱→¬降息紧;LEAD;且**跳出 N3 共享结算源陷阱**——不是"Fed 决议"合约) |
| 大选 | 执政党赢总统 | L4 分区补集：挑战党候选人赢 YES(Fréchet 端点,一次覆盖所有失败态) | **P1 经济 fork**：2026 衰退/高通胀 YES(共同驱动 Z=经济,与执政党败同动;LEAD;regime 脆) |
| 加密 | 年底前批准现货 SOL ETF | —(否定/互斥腿多半无合约) | **C2**：SOL ETF **开始交易** NO(交易需先批准,¬上市→¬批准近逻辑);诚实旗:锚可能已近确定/被 price-in |
| 公司财报 | Nvidia 下季营收超预期 | L3/L4：miss/in-line 补集(免因果判断) | **C3 PREVENT**：美扩大对华 AI 芯片(H20 类)出口管制 YES(政治/法律域→公司财报的**跨域抑制**,LEAD,在 miss 态赔付) |
| 地缘 | 以哈停火 12/31 仍成立 | L3 互斥：以军重启大规模地面攻势/停火崩 YES(逻辑近互斥,LEAD) | **C2**：以沙关系正常化 NO(正常化需稳定停火为前置,覆盖更广外交崩溃失败集) |
| 气候 | 今年刷新全球均温纪录 | L4/W2 补集(多半无合约) | **C2**：2026 出现(中强)拉尼娜 YES(刷新纪录近逻辑要求"无强拉尼娜降温";ENSO/海洋态,**不同指标类**;LEAD;NOAA-ENSO 合约已现于 Kalshi) |

**三条可迁移的规律(跨全部 6 域一致成立)：**
1. **最强"同维完整对冲"总是 L3/L4 结构补集**(免 LLM sign、免结算数据、Fréchet 端点)——但常是同维度、且子集腿会抬高 strict worst-case。
2. **真正的跨维度差异点总是那 1 条 soft 腿,压倒性地来自 C2 前置条件 / C3 抑制 / P1 共因**——且几乎总是 **LEAD**(前置/驱动先于 anchor 结算,能提前保护决策)。这验证了 §13 的对冲排序。
3. **N3 共享结算源是最常见的隐形陷阱**:同域的"直接决策"合约(Fed 决议、各 altcoin ETF)彼此**共享结算源**,不是分散腿而是相关失效腿;跳出它恰恰要靠**跨维度的前置/驱动市场**(劳动数据、出口管制、ENSO)——**"跨维度"不只是产品差异点,更是规避相关失效的必需**。

**你的西班牙例子在这张表里只是"体育域的一行"**:injury/coach = C3 对"西班牙夺冠"、对"夺不了冠"这个赌注是同向放大器;真正对冲是 L2 子集(欧洲/进决赛)+ C1/P1(金靴)。6 域实测说明:**换任何域,同一套算子都能自动定位到对应的 C2/C3/P1 跨维度对冲**,无需为体育或任何域写专门逻辑。

## §16 泛化验证记录（8-agent workflow，2026-07-01）

**6 域实测 + 泛化审计 + 逐条独立核实。** 结论 `generalizes=true`;审计对代码声明逐一 spot-check 通过(optimizer 封闭派发/1 soft 腿上限/discover.ts:1043 合并/eventDimension/comboOverlap/direction-in-bucket-key/structuralCompanions 仅洲际——全部属实);诚实底线守住(无市场因子降级为解释、未证明腿不打 CALIBRATED、Fréchet 双边窗纪律)。

**已修正的确认缺陷(均 LOW,本稿已改)：**
- §13 sign 列改为**边-相对**(该算子提议的那条 YES/NO 腿对 anchor 的符号,HEDGE 按构造为负)——消除"正相关实体却标 HEDGE"的歧义。
- §13 补**算子↔现有 `MechanismEdgeKind` 边类型**近 1:1 映射(ENABLES/INHIBITS/SHARES_DRIVER/RESOLVES_WITH/SIGNALS/IMPLIES 均已存在);并诚实标注 **N3(RESOLVES_WITH)可表达但无代码消费、P3 collider 无枚举无检测 → 目前纯 prompt 拒绝、零代码强制**。
- provenance 更正为 **4 值(含 HYPOTHESIS)**;HYPOTHESIS = 既有"仅 LLM、永不进 payoff"最底层 = 未接地端的诚实归宿。
- §14 WALK-B 的 `protect.ts` 引用更正为 `/protect` 面 + 优化器 uncovered 会计(`lib/hedge/protect.ts` 已不在)。

**被驳回(核实后确认非文档缺陷)：**
- "WALK-B 可被静默跳过"——审计据以立论的是某个 workflow agent 的地缘链真的漏了 pre-mortem;但那是**实现期 LLM 可靠性**问题,不是文档缺陷(文档明列 pre-mortem 为最高价值步)。**真正教训(已吸收)**:WALK-B 靠 prose 强制不够,**实现时应把"逐失败子态"做成结构化必填槽**(否则模型会偷懒跳过)——该约束仅在生成式 WALK（§18 已推迟）落地时生效；当前先行的只是对既有召回的覆盖记账（§18#2）。
- "0–1 跨维度可交易腿被当常态"——只是重述文档 §7 Phase-1.5 / §8 早已醒目自陈的 caveat,非新缺陷。

**净结论:深化后的发现内核 = 域无关算子本体 + 双向 walk + 反锚定覆盖,经 6 域实证泛化成立、经对抗核实诚实底线完好;剩余全部是 LOW 级文档准确性,已修。产品成色的真正门仍是 §7 Phase-1.5 的跨维度可交易腿命中率实测。**

---

# 第三部分：多腿相关对冲 + 比例 sizing（owner 追问 2026-07-01）

> owner 追问："对冲策略可以是多腿的，多腿逻辑里每个事件之间都存在关联，但最终靠组合结果或**投注比例(sizing)**达成对冲。检查能不能做到。" 这一问直接顶在前文反复标注的"optimizer 只允许 1 条 soft 腿"约束上。以下是**读实际求解代码后**的精确回答（`superpose.ts` / `comboOverlap.ts` / `jointCalibration.ts` / `optimizer.ts` 全部核对过；注意 memory 里的 `lib/hedge/maximin.ts`/`cvar.ts` 已删除，现存分配器就这几处）。

## §17 能不能做到：能，核心已 LIVE；完全诚实版需"失败情景分区 LP"

**一句话（经对抗验证修正）：多腿 + 比例 sizing + 腿↔anchor 相关——已经 LIVE。腿↔腿 相关目前只用于"选腿/去冗余"，还没进 sizing。把 ≥2 条相关 SOFT 腿一起按比例 sizing 而不高估，只有在这些腿的失败态在结构上互斥(ANALYTIC)或已 JOINT-CALIBRATED 时才诚实；失败情景分区能把"全局至多 1 条 soft 腿"细化到"每个结构互斥格至多 1 条 elicited soft 腿"——这是真实改进，但不是"无条件任意腿数都安全"。**

### 三级成熟度（全部已在代码里）

| 层 | 文件 | 做到了什么 | 状态 |
|---|---|---|---|
| **多腿 + 比例分配 + 腿↔anchor 相关** | `lib/relate/superpose.ts` | `buildSuperposition` 建 ≤4 腿、**一维度一腿**、**按 edge 比例 water-fill 预算**（`:199-219`，per-leg cap 促成——当 ≥2 腿合格时——真正堆叠；单腿合格则 1 腿组合亦有效）；每腿带 `pWin/pFail`（条件于 anchor 结果 = 与 anchor 相关）；保守方向堆 fail-paying 腿 → anchor 失败时少亏 = **对冲**。这正是 owner 说的"多腿 + 投注比例达成对冲"。 | **LIVE**（/hedge 面 + bipolar superposition） |
| **腿↔腿 相关** | `lib/relate/comboOverlap.ts` | `overlapPenalty(a,b)` 用**失败情景重叠**建模腿间相关（同市场 1.0 / 同标题异结果 0.9 / 同情景 0.7、两条 unrelated_control 同情景 0.5 / 同事件异情景 0.35 / 跨事件异情景 0.2）；`conservativeCoverage = 1−∏(1−pᵢ·(1−penaltyᵢ))`。**契约明确"never size a position"**——现仅接在 `discover.ts:789` 做**二元选腿门**（`marginalCoverageGain < 0.02 就跳过`），**两条被选中的腿并不因相关而被联合重新 sizing**。 | **LIVE（仅选腿/去冗余，未进 sizing）** |
| **腿↔腿 相关的结算校准 + 联合层** | `lib/relate/jointCalibration.ts` | `learnedOverlapPenalty` 用真实"A 赔时 B 也赔"的独立失败 episode（≥30）把规则罚替换为学到的罚；`jointCalibratedGate` 决定某 combo 家族能否进 JOINT-CALIBRATED（≥100 cluster、combo 覆盖胜过最佳单腿、第 2 腿有实测边际贡献、premium drag≤target、walk-forward ECE≤0.1、无单 cluster 主导）。 | **DORMANT**（无数据 → `eligible:false`，诚实） |

### 当前诚实约束（为什么 optimizer 封在 1 条 soft 腿）

`optimizer.ts:159-171` 注释写得很清楚：sized 推荐用**可加**会计（`remainingModeledLoss -= Σ 每腿 reduction`），这**只在腿覆盖不相交失败子态时正确**；两条相关 soft 腿若在**同一失败子态**赔付，可加会**高估**对冲。无 copula 时无假设的联合下界是 `max_i(reductionᵢ)`（第 2 条相关 soft 腿的**保证**增益可能为 0），所以为诚实先封在 1 条。**注意：superpose 的 `failLegPnl` 也是按腿累加（`superpose.ts:235`），即假设各腿在 anchor 结果给定后条件独立——它靠"一维度一腿"来近似"不相交"，是 DISPLAY 层的合理近似，但不是 sized 推荐的严格保证。** 这就是差距所在。

### 更诚实的做法：失败情景分区 + "按格 max_i"（把上限细化，而非无条件放开）

把 owner 的"每腿相关、比例达成对冲"落成一个 overlap-aware 分配器。**关键的诚实修正（对抗验证抓到的 HIGH 缺陷）：分区只消除"跨格"双算，不消除"格内"联合。** 同一失败情景 Fᵢ 内两条 soft 腿（各 p<1）的联合无 copula 不可定，诚实下界仍是 `max_i`（就是现有上限逻辑）。所以：

1. **WALK-B（§14）给出 anchor 失败态的情景分区** {F₁..Fₖ} + P(Fᵢ|fail)。**这些权重是 elicited（LLM pre-mortem），不是市场边际**，本身带 §2 的 ~14% 方向误差 + 谄媚风险——**不是 ANALYTIC 输入**。
2. **每条候选腿 → 分区覆盖向量**（在哪些 Fᵢ 赔付、各自条件概率）。**这是要新建的数据结构**：`superpose` 现在只带**标量** `scenario` 标签、`comboOverlap` 的 `pGivenFails` 也是标量，都不是覆盖向量。
3. **解分配（比例 x_j）** 最小化分区上的**最坏态 / CVaR 损失**，且每个输入（分区权重 + 每格覆盖）都取其 **Fréchet 窗的最坏端**，不是点估计——否则"safe"只是贴在 modeled 输入上的空词。约束预算 =(1−k)·W、每腿 ≤ 执行深度。
4. **跨格加性只有在"格结构互斥"时才诚实**：Fᵢ 之间**逻辑互斥**（单胜者场的不同赢家、同一量的不同阈值区间）时，不同格的腿加性正确；**任一格内 ≥2 条 elicited soft 腿 → 回退到该格的 `max_i` 下界**（现有上限逻辑，按格施加）。**不可**用 `comboOverlap` 去 sizing——其契约明写"never size a position"，只用于选腿。
5. **所以上限是"按格"诚实放开，不是无条件放开**：可以有多条 soft 腿，**但每个结构互斥格至多 1 条 elicited soft 腿**（否则该格取 max_i）。要在**同一格内**放 ≥2 条 soft 腿并加性 sizing，必须先有 (a) 结构/ANALYTIC 的互斥证明，或 (b) `jointCalibratedGate` 通过的真实结算证据。**elicited-only 的"不相交"永远不算证明**（共同驱动会让支撑跨名义格泄漏 = 更隐蔽的双算）。
6. **置信**：这个分区分配器整体是 **GROUNDED 层**（输入 elicited），**不是 ANALYTIC、不是结算替代**；结构互斥格 = ANALYTIC；combo 真结算过 `jointCalibratedGate` = JOINT-CALIBRATED。overlap 罚现用规则、后用结算学到的，平滑升级——但**仅在选腿层，不在 sizing 层**。

### 落点与不变量

- **复用 vs 新建（验证补正）**：**真正可复用的三件**是 `superpose` 的比例 water-fill 骨架（`superpose.ts:199-235`）、`comboOverlap` 的情景罚（**仅选腿层**）、`jointCalibration` 的门。**要新建的两件**是 WALK-B 的失败分区 {F₁..Fₖ}+P(Fᵢ|fail)、以及**每腿的分区覆盖向量**（现有只有标量 scenario 标签）。所以是"接线 + 补两个数据结构 + 按格 max_i 的分配器"，比"只差接成一个 LP"要多一点，别当成零成本。
- **诚实红线不变**：headline 覆盖/最坏损失取 Fréchet/分区下界；**格内 ≥2 elicited soft 腿取 `max_i`、不加性**；每加一腿付 vig（premium drag ≤ kept-if-win）；未结算联合强度**永不**标 JOINT-CALIBRATED；EV ≤ market。
- **诚实局限**：分区权重与覆盖是 elicited（GROUNDED，非 ANALYTIC）；"证明多腿联合有效"仍需 JOINT-CALIBRATED 的慢结算数据。

**净答（据实修正）：owner 要的"多腿 + 腿间相关 + 比例达成对冲"分三档诚实回答——(1) 对 STRUCTURAL 腿(互斥/子集/分区)完全成立且已 LIVE:可按比例 size 很多条,腿间相关因逻辑互斥被精确处理,这是最强、免数据的多腿对冲;(2) "1 条 soft 因果腿 + 多条结构腿"已 LIVE;(3) 把 ≥2 条相关 SOFT 腿放同一失败态里一起加性 sizing,诚实上限是 `max_i`,除非它们结构互斥(ANALYTIC)或已 JOINT-CALIBRATED。失败情景分区把上限从"全局 1 条"细化到"每个结构互斥格 1 条 elicited soft 腿"——真实改进,但不是"无条件多腿 Fréchet-safe"(前一版把这点说过头了,已据对抗验证 HIGH 修正)。**

### §17 验证记录（3-agent 对抗验证 + 逐条核实，2026-07-01）

对 §17 初稿 3 视角批判(概率正确性/代码可行性/是否答题)→ 逐条独立核实,**0 条被驳回**,确认初稿有真实 HIGH 缺陷,已全部修：
- **[HIGH]** "分区 LP 对任意腿数 Fréchet-safe"**错**——分区只消跨格双算,格内 ≥2 soft 腿仍需 copula,诚实下界是 max_i → 已改为"按格 max_i、每结构互斥格至多 1 条 elicited soft 腿"。
- **[HIGH]** LP 的"safe"是贴在 elicited 输入(分区权重/覆盖)上的空词;且不得拿 `comboOverlap`(契约"never size")去 sizing → 已改为 GROUNDED 层 + 输入取 Fréchet 窗最坏端 + comboOverlap 仅选腿。
- **[MED]** 腿↔腿"LIVE"过头(仅 `discover.ts:789` 二元选腿门,不联合 sizing)→ 表格状态已改。
- **[MED/LOW]** 跨格加性对 elicited 覆盖是未证明的(共同驱动泄漏)、"零件都已存在"低估了工作量(分区+覆盖向量是新结构)、overlapPenalty 表漏 0.9/0.5 两支、"per-leg cap 强制 ≥2 腿"不保证 → 全部已据实修正。

---

# 第四部分：全方案重审 —— "该不该用 agent / 有没有更好方案"（owner 追问 2026-07-01）

> owner 追问："为什么当初没想到用 agent 优化整个过程？如果 agent 能带来好处，重新审查整个方案，每个部分都重新思考有没有更好的方案。" 方法：9 组件各一个审计员(逐组件问"当前是不是最优 / 更好方案是 agentic 还是非 agentic / 对可复现·飞轮·不变量的影响 / 优先级")+ 反"过度 agent 化"综合 + HIGH 级独立核实 + 关键事实 spot-check。

## §18 重审结论：**大多数部分不该上 agent；两个最高价值赢点都是确定性的**

**为什么当初没想到用 agent（诚实复盘）：** 不是"评估过觉得没效果"，而是 (1) 奠基约束"诚实底线 + 结算护城河"要求候选集**可冻结可回放**（`candidateSnapshot.ts`），把"确定性流水线"设成了不假思索的默认；(2) 诊断出的瓶颈是**数据/结算**不是发现，聪明的发现 agent 不动产品指标（MEMORY 审计"约束是需求/数据不是更多引擎"重申）；(3) 一个真实盲点——**把"确定性"误当"可靠/已论证"**，于是 `optimizer.ts:136` 的 0.2/0.15、`:123` 的平值 0.6、那个 vaporware 验证层从没被审计。

**逐组件定稿（9 个）：**

| # | 组件 | 定案 | 是否 agent | 优先级 | 要点 |
|---|---|---|---|---|---|
| 1 | 发现召回 | **FIX + KEEP 架构** | 非 agent | **HIGH** | **最大赢点**：`marketIndex.ts:99` 前导通配 `ILIKE '%tok%'` 全表扫描(无 GIN/pg_trgm，`lib/data/db.ts:218-219` 只有 btree)→ 每次查询+每小时 cron 都扫全目录、随索引无界膨胀 → 加 GIN+pg_trgm。**不要加实时 agentic 搜索循环**(破坏冻结不变量) |
| 1b | 召回 token 规则 | UPGRADE | 非 agent | HIGH | 长度下限≥4 + 8 上限**把 Fed/UK/EU/AI/GDP 全丢**(最富跨维度矿脉)→ 降下限+缩写白名单；re-rank 换成已有 `lexicalSimilarity` |
| 2 | 算子 WALK | **KEEP 单调用召回 + 加 2 个确定性 fail-closed pass** | 非 agent | HIGH/MED | 不上生成式辐射(广度非瓶颈)；把两条**纯 prompt 的诚实保证变代码**：遍历已有 `MechanismEdgeKind` 图(types.ts:19)自动拒 N3 共享结算源(RESOLVES_WITH)+ P3 collider；覆盖记账 pass 记录既有单调用召回对 §13 算子表的覆盖/显式 NONE(空算子行=显式裸露向量)；"必填槽防静默跳过"约束留待生成式 WALK(已推迟)落地时生效 |
| 3 | sign + M 轴验证 | FIX | 半 agent(离线) | MED | **M 轴今天不成立**：链是单应答顺序回退(每调用仅一个模型作答、非并行采样)，且以 Qwen 系为主(7/9,另 1 为 Qwen 蒸馏,`modelFallback.ts:3-13`)、同一 DashScope 端点 → "多模型共识"今天是假的；只能叫"对抗框架否决"，除非加真正非 Qwen 模型并行采样 |
| 4 | 反谄媚 | UPGRADE | 半 agent(**离线**) | MED | 现仅一条正则(`elicit.ts:124`，模型自招才触发)→ 升级成**离线、只取 sign 的对抗性自一致否决**(两次 temp-0 换框架、sign 不一致就 abstain→φ=0)。**只撤腿不造信心**(fail-closed)，跑在 cron 冻结路径 |
| 5 | 定界/排序常数 | UPGRADE | 非 agent(离线) | MED | Fréchet clamp 是真不变量(保留)；0.2/0.15 权重只层内重排、造不出 EV-正；**最弱是平值 0.6**→由 bucket 证据推 uncertainty(像 CALIBRATED 分支 `:78`)，权重用已有 `walkForwardByBucket` 拟合，冻进 snapshot |
| 6 | 校准 reference-class | KEEP 估计器 + UPGRADE 加外部先验层 | 半 agent(离线构建) | MED | 加 REFERENCE_CLASS 层给未结算 bucket day-1 grounded 信号。**诚实墙(硬)**：外部伪计数单列 typed 字段，**绝不进 `sufficientEvidence` 门读的 ConditionalCounts 格**；先落"隔离字段+provenance 不变量+回归测试"再建先验器 |
| 7 | **ANALYTIC 泛化** | **UPGRADE** | **几乎纯确定性** | **HIGH(第二大赢点)** | `structuralCompanions.ts` 被 `CONF_CONTINENT`/`confederationOf` 锁死在足球→**足球外覆盖为 0**。但**域无关原语早已存在**：`mutuallyExclusiveEvent`(types.ts:21,来自 venue negRisk 元数据)+`eventKey`，且域无关的精确结构规则已在 `lib/relate/classify.ts:21-55` `ruleClassify`(R1: mutuallyExclusiveEvent+eventKey→mutually_exclusive、精确联合 0；R2: sameEntityStrict+partitionsAligned→same)；`lib/link/classify.ts:44-131` 另有(世界杯专用的)ANALYTIC 发射器模式可借鉴——**structuralCompanions 都不消费它们**。改：让它吃通用 `mutuallyExclusiveEvent+eventKey` 兄弟 → 对**任何单胜者事件**(选举/各种"谁赢"/奖项/FOMC 档)发 Fréchet-精确 ANALYTIC 腿 + 数值阈值子集梯。成员关系来自 venue 元数据(满足"LLM 永不设 structuralCoverage")。**复用现有字段、小改动、放大最可信免数据层、支持无界精确多腿** |
| 8 | 多腿 sizing(§17) | KEEP | (离线向量可选) | LOW | §17"分区+按格 max_i"就是最优诚实做法。离线覆盖向量能把上限"全局 1→每不相交格 1"，但**Phase-1.5 证明需求前不建** |
| 9 | 运行时架构 | UPGRADE | 半 agent(离线) | MED | 整-anchor 富集缓存由每小时 radar 写、实时只跑确定性尾段+实时价格、冷 anchor 标 `live-uncached`。**关掉"实时 discover 把不可复现行写进护城河"漏洞**，p50 10–60s→1–3s。价格永不缓存；不变量门留确定性尾段 |

**两条元结论：**
1. **对这个产品，"更多 agent"大多是错的**——瓶颈是数据/可用性，冻结路径的确定性是最承重的不变量。**只有 2 件值得半 agent 化(反谄媚、运行时缓存)，且都只因为跑在离线冻结路径**；实时热路径**永远不放不确定性**。
2. **两个最高价值赢点都是确定性的、不是 agent**：(a) GIN 索引(修一个随规模无界膨胀的全表扫描)；(b) **ANALYTIC 泛化**(把最可信、免数据、支持无界精确多腿的顶层从"只覆盖足球"变成"域无关"，复用已存在的 `mutuallyExclusiveEvent+eventKey` + `lib/relate/classify.ts ruleClassify` 精确规则)。—— 正好接上 owner 关心的多腿:**结构互斥分区支持按比例 size 无界多条精确 ANALYTIC 腿**(§17 规则 1),泛化它=直接把"多腿相关对冲"从足球放到所有域。

**执行顺序：** Gate 0 先跑 **Phase-1.5 命中率实测**(定瓶颈是不是召回/可用性)。然后并行两条 HIGH 确定性主线:**① GIN 索引 → token 下限/缩写 → lexicalSimilarity re-rank；② ANALYTIC 泛化(独立、可与①并行)**。再 N3/P3 拒绝 + 覆盖记账。再离线:定界常数接地 / REFERENCE_CLASS(墙先行) / 反谄媚否决 / 运行时缓存。**推迟**:embedding 持久化、生成式 WALK、多腿向量 sizing——等 Phase-1.5 需求信号。

---

# 第五部分：最终方案（终审定稿，2026-07-01）

> 本节是全文的**收敛定案**。经五轮独立验证（Part I 8-agent 对抗验证 → Part II 6 域泛化实测 → §17 三视角核实 → §18 9 组件重审 → 端到端一致性 + 引用时效终审，本轮 11 条确认缺陷已全部修入上文），凡与前文冲突处，**以本节为准**。

## §19 最终方案

### ① 北极星（不变）
条件损失最小化（不是预测）；EV ≤ market；real markets only；NO_GO/ABSTAIN 一等公民；L2/L3 法律门不动。

### ② 方案之根：解耦
把两件事解开——**"因果关系真不真"**（数据丰裕：LLM 方向判断 + 结构元数据 + 历史 base rate）与 **"是不是结算证明的可执行对冲"**（数据稀缺：4 年一届世界杯）。前者**立即可用、诚实标注**；后者继续由结算飞轮慢慢证明，**CALIBRATED 门槛与定义一字不改、结构隔离**。这就是"绕开慢数据"的全部含义：降低依赖 ≠ 消除，护城河照旧积累。

### ③ 最终置信梯（定案）
```
ANALYTIC        结构强制（venue 元数据 / 逻辑互斥·子集·分区），Fréchet 端点，免数据，腿数不设限
CALIBRATED      结算专属（20/branch，冻结快照，走前向验证），外部证据结构上永不能触及
REFERENCE_CLASS 【唯一新增 provenance】外部 base rate + 经验贝叶斯收缩；伪计数放隔离字段，
                永不进 sufficientEvidence 所读的 ConditionalCounts；先落墙+不变量测试，再建先验器
MODELED         LLM 先验（±"接地徽章"：E 轴证据只收窄区间、不升层；M 轴待跨族并行采样后启用）
HYPOTHESIS      既有最底层，仅展示、永不进 payoff
（REJECT = Group-IV 否决 → ABSTAIN，不是 provenance；SPECULATIVE = HYPOTHESIS 的表内别名）
```

### ④ 发现内核（定案）
- **召回保持单调用**（embed 语义 + LLM recall + lexical），scenario-expansion 作为该调用内的 prompt 变体；**不建实时 agentic 循环**（会破坏 candidateSnapshot 冻结）。
- **§13 算子本体的角色 = 分类·记账·拒绝本体，不是生成循环**：N3 共享结算源（RESOLVES_WITH 边）与 P3 collider 拓扑做成**确定性图拒绝**；覆盖记账把"哪些算子行为空"显式呈现为裸露向量。
- 生成式 WALK-A/WALK-B、KG 接地（CauseNet/ConceptNet）**推迟**，等 Gate 0 证明召回是瓶颈。

### ⑤ 多腿（定案，owner 的比例对冲之问）
- **结构腿（互斥/子集/分区）**：按比例 size **不设上限**、Fréchet 精确——这是"多腿相关+比例达成对冲"的完全体，且免结算数据。
- **soft 因果腿**：每**结构互斥**失败格 ≤1 条；格内/未证不相交的加性需 ANALYTIC 互斥证明或 JOINT-CALIBRATED 结算证据。
- **ANALYTIC 泛化**（见⑥ Gate 3）把结构多腿从"只有足球"解锁到**所有域**——这是对该问题最大的实际回报。

### ⑥ 唯一执行时序（取代 §7 编号；每步带门槛测试）
| Gate | 内容 | 通过标准 |
|---|---|---|
| **0** | **Phase-1.5 命中率实测**（离线统计：N 个真实 anchor → 因果邻居 → 落到活跃合约的跨维度腿中位数） | 得出瓶颈判定：召回 vs 市场可用性；若中位数 0–1,价值主张改为"讲清因果版图+偶尔跨市场腿" |
| **1** | GIN/pg_trgm 索引修 `marketIndex.ts:99` 全表扫描 | `EXPLAIN ANALYZE` 显示 index scan;召回延迟不随目录增长 |
| **2** | token 下限/缩写白名单 + `lexicalSimilarity` re-rank | Fed/UK/EU/AI 有非空召回;固定 anchor 的 snapshot replay 字节一致 |
| **3**（可与 1-2 并行） | **ANALYTIC 泛化**：`structuralCompanions` 改吃 `mutuallyExclusiveEvent+eventKey`（复用 `lib/relate/classify.ts ruleClassify` R1/R2）+ 数值阈值子集梯；洲际表降为 overlay | 选举/FOMC 档/奖项类 anchor 产出 Fréchet-精确结构腿;成员关系全部来自 venue 元数据 |
| **4** | N3/P3 确定性拒绝 + 覆盖记账 | 合成 RESOLVES_WITH 共源对被拒;空算子行显式呈现 |
| **5**（离线件） | 定界常数接地（平值 0.6→bucket CI 宽度;0.2/0.15→`walkForwardByBucket` 拟合+测试钉住）/ REFERENCE_CLASS（先墙后先验器）/ 反谄媚对抗框架否决（cron 冻结路径,只撤腿）/ 整-anchor 富集缓存（价格永不缓存;不变量门留确定性尾段;冷 anchor 标 `live-uncached`） | 各自的回归测试 + replay 一致性 |
| **DEFER** | embedding 持久化、生成式 WALK-A/B、多腿覆盖向量、KG 接地、非 Qwen 模型（M 轴前提） | 仅当 Gate 0 显示召回是瓶颈 / 需求信号出现 |

### ⑦ 不变量（永不破，全部已结构化或待结构化为代码+测试）
CALIBRATED 只来自真实结算（外部计数隔离字段）；LLM 永不设 `structuralCoverage`、永不出裸概率（只出方向与结构，数值一律有界区间）；Fréchet 天花板；EV ≤ market；de-vig；near-touch 执行；无市场的因果因子只解释、不成腿（不可交易对象）；**实时热路径零不确定性**——一切生成式/agent 工作离线跑、写入版本化冻结缓存；封闭 provenance 派发 + 每结构互斥格 ≤1 soft 腿。

### ⑧ 一句话总结
**用"结构 + 方向 + 外部历史 + 硬边界"立即回答"什么能对冲、往哪边、界多少"，让慢结算数据只回答"哪类已被证明"——发现即刻可用、诚实分层、护城河照旧生长；最先做的两件事是一条 SQL 索引和一次结构泛化，而不是更多 AI。**
