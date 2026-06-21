# HedgeAdvisor MVP 技术方案（路线 B）

> 成本感知的预测市场风险/决策工具。用户输入一个持有/看好的仓位（如"西班牙夺冠"），
> 系统发现相关市场、用**真实订单簿成交价+手续费**算出诚实的对冲净成本、给出可解释的
> go / no-go（"这个对冲不值"是一等公民输出），并解释为什么。**只建议不执行。**
>
> 所有 API 事实、费率公式、订单簿结构均已对 Polymarket 实盘端点核验（2026-06-15）。
> 下面标 ⚠️ 的是核验阶段抓出来的、照原样写会直接让实现出错的坑。

---

## 0. 经过核验的"地面真相"（先读这个，否则会写错）

| 事实 | 真相 | 注意 |
|---|---|---|
| **体育动态 taker 费** | `fee_usd = C × p × 0.03 × p(1−p)`，**在 p=0.5 处峰值 0.75%**（不是 1.8%）。活体 feeSchedule = `{"exponent":1,"rate":0.03,"takerOnly":true,"rebateRate":0.25}`，`feeType:"sports_fees_v2"` | ⚠️ 我之前给你的 1.8% 是**加密 15 分钟档**，体育档是 0.75%。这把对冲成本砍掉约 2.4 倍。Maker(限价)≈0 费，**卖单免费**，赢了 $1 兑付 0 费 |
| **订单簿排序** | `bids` **升序**（最优买价 = 最后一档/最大）；`asks` **降序**（最优卖价 = 最后一档/最小）。**与官方文档相反** | ⚠️ 最高危。任何"取 asks[0] 当最优卖价"的走簿逻辑会吃到 0.999 最差档。必须在数据边界**强制归一化**：`asks.sort(升)`、`bids.sort(降)`（或取 min/max） |
| **clobTokenIds / outcomePrices / outcomes** | 是 **JSON 编码的字符串**，如 `'["4394...","1126..."]'`，不是原生数组 | ⚠️ 索引前必须 `JSON.parse`，否则 `clobTokenIds[0]` 取到字符 `[`。`clobTokenIds[0]`=YES，`[1]`=NO |
| **"夺冠"事件结构** | `GET /events?slug=world-cup-winner` → 一个 negRisk 事件，`markets[]` **正好 60 个**互斥结果，共享 `negRiskMarketID` | 用 negRiskMarketID + 事件归属来分组互斥集 |
| **tags** | 只在**事件级**存在（无 per-market tags），且是对象 `{label, slug, id}` | 入库时拍平成 slug/id。事件级 tag（如 `2026 FIFA World Cup` id 102350）用来找相邻事件 |
| **prices-history** | `?market=<tokenId>&interval=1m&fidelity=60` → `{history:[{t,p}]}`，744 个小时点/31天。**市场一旦结算，粒度退化到 12h+** | ⚠️ 这是护城河理由：必须在赛事进行中**实时抓存**细粒度序列，事后无法重建 |
| **微观结构** | 显示的是**中间价**，可成交价更差。tick=0.001，min_order_size=5，单边深度约 $5–15k | 永远走订单簿算 VWAP，不要用 midpoint/outcomePrices 当成交价 |
| **negRisk 内对冲是数学幻觉** | 同盘买补集 = 降方差，**扣 vig+价差+费后严格负 EV**。付 $0.85 换 $1 的亏损覆盖，那 $0.15 是 vig 不是费 | 产品绝不能把对冲说成"免费降险/赚钱" |

---

## 1. 架构与技术栈

**栈（为 5 周内单人交付优化，最少活动件）：**

- **Next.js (App Router) on Vercel** — UI + API routes，Node runtime（Fluid Compute）跑抓取器。
- **Neon Postgres**（Marketplace）— 目录表 + 自有时序快照（护城河）。
- **Upstash Redis**（Marketplace）— 热价格/订单簿短 TTL 缓存 + 速率令牌桶。
- **Vercel Cron** — 每分钟快照抓取（数据护城河从第 1 天开始累积）。
- **Vercel AI Gateway + AI SDK** — LLM 解释层，用 `"provider/model"` 字符串（如 `anthropic/claude-haiku-4.5`，按需升 `claude-sonnet-4.5`；当配置项，可换）。
- **全 TypeScript**。统计（Kelly/蒙特卡洛/协方差收缩）都是轻量数学，TS 够用，不引 Python，少一个 runtime。

> ⚠️ **v1 砍掉 WebSocket。** 文档里的常驻 WS collector 是单人 5 周里最大的基础设施风险，而 Vercel 函数撑不住长连接。用 **每分钟 cron + 短 TTL Redis** 做护城河和"准实时"重定价，demo 标注"约 60 秒更新一次"。WS 留到 v2 用独立 worker(Railway/Fly)，且只在"比赛中秒级重定价"是核心卖点时才上。

```
 用户 "西班牙夺冠"
        │
        ▼
 [Next.js /api]  ──resolve──► lib/data ──► Neon 目录 + Upstash 热缓存
        │                        │
        │                        ├─► lib/correlation (含 devig) ──┐
        │                        │                                 ├─► lib/sizing ──► 唯一 go/no-go (Decision)
        │                        └─► lib/netcost (走簿+费) ────────┘            │
        │                                                                        ▼
        │                                                              lib/explain (LLM, 只解释不造数)
        ▼
  [Vercel Cron 每分钟]  批量 /books + /midpoints ──► book_snapshot (Neon) = 专有时序护城河
```

**模块边界（`lib/types` 是唯一契约源，所有模块从它 import，禁止各自定义/各自重算）：**

```ts
// lib/types.ts —— 唯一契约。⚠️ 必须携带 per-leg 费率字段、de-vig 概率 q、resolved 标志。
export type Price = number;            // 0..1
export type TokenId = string;

export interface OrderLevel { price: Price; size: number; } // size = 份数(shares)，在数据边界由字符串 parse
export interface Book {
  bids: OrderLevel[];   // 归一化后：降序，bids[0] = 最优买价
  asks: OrderLevel[];   // 归一化后：升序，asks[0] = 最优卖价
  midpoint: Price;
}

export interface MarketRef {
  conditionId: string;
  eventId: string;
  groupItemTitle: string | null;       // "Spain"
  tokenIdYes: TokenId;
  tokenIdNo: TokenId;
  midpoint: Price;
  resolved: boolean;                    // ⚠️ 赛中可能某腿已结算
  resolvedOutcome?: 'yes' | 'no';
  // 费率字段从 lib/data 一路带过来，不许在下游丢失：
  feeRate: number;                      // 0.03 (sports)
  feeExponent: number;                  // 1
  feeTakerOnly: boolean;                // true
}

export interface FilledLeg {
  ref: MarketRef;
  shares: number;
  avgFillPrice: Price;                  // 走簿 VWAP
  worstFillPrice: Price;
  slippagePerShare: number;            // avgFill - midpoint
  takerFeeUsd: number;
  entryCostUsd: number;                 // 价差+滑点+费(买入)
  capacityHit: boolean;                 // 深度不够，价格不可达
}

export type ReasonCode =
  | 'GO' | 'PARTIAL'
  | 'COST_EXCEEDS_BENEFIT' | 'NEGATIVE_EV_VIG' | 'INSUFFICIENT_DEPTH'
  | 'NO_CORRELATED_LEG' | 'LEG_RESOLVED' | 'CANNOT_PRICE';

export interface Decision {            // ⚠️ 唯一裁决，由 lib/sizing 产出
  verdict: 'GO' | 'PARTIAL' | 'NO_GO';
  reason: ReasonCode;
  legs: { ref: MarketRef; shares: number; band: [number, number] }[];
  totalHedgeCostUsd: number;
  riskBefore: { stdDev: number; maxLoss: number; cvar: number };
  riskAfter:  { stdDev: number; maxLoss: number; cvar: number };
  eta: number;                          // 每 $ 成本移除的风险($)
  facts: Record<string, string>;        // 给 LLM 的预格式化字符串(由唯一 formatter 生成)
}
```

---

## 2. 模块一：数据层 / API 接法（API接法）

三个只读、免鉴权主机：`gamma-api.polymarket.com`（元数据/发现）、`clob.polymarket.com`（订单簿/价格/历史）、`data-api.polymarket.com`（持仓/成交）。

### 2.1 仓位解析（自由文本 → 具体市场）

```
A. GET /public-search?q=Spain%20World%20Cup   // 只用来"定位父事件"，不直接选结果(它按相关度排，粒度会错)
B. GET /events?slug=world-cup-winner          // 取回事件 + markets[](60个互斥结果) + negRiskMarketID
C. 本地按 groupItemTitle 模糊匹配队名(不要匹配 question —— 60个 question 几乎一样会误判)
```

```ts
// ⚠️ clobTokenIds/outcomePrices 是 JSON 字符串，先 parse
function toResolved(event, m) {
  const tokenIds = JSON.parse(m.clobTokenIds);   // ["YES","NO"]
  return {
    conditionId: m.conditionId,
    groupItemTitle: m.groupItemTitle,
    tokenIdYes: tokenIds[0], tokenIdNo: tokenIds[1],
    outcomePrices: JSON.parse(m.outcomePrices),
    feeRate: 0.03, feeExponent: 1, feeTakerOnly: true,
  };
}
```

歧义处理：top 匹配分 ≥0.85 且领先次优 ≥0.15 → 直接解析；0.5–0.85 → 返回候选让用户选；<0.5 → not_found。用一张小的 `slug_alias` 表（常见说法 → canonical slug）省搜索配额。
可选"链上持仓"：`GET /positions?user=0xWALLET`（用户自己粘钱包，只读、按需）→ 用真实份数和均价，让 go/no-go 变精确而非假设。

### 2.2 相关市场发现（候选对冲池）

⚠️ **没有 per-market tags**，所以分两层：

- **Tier A（精确，无需种子数据）**：同 negRisk 事件的兄弟结果 —— 用共享 `negRiskMarketID` 取全部 60 个。互斥关系可自动推导。
- **Tier B（需要种子）**：相邻事件 —— 用**事件级 tag**（`2026 FIFA World Cup`）拉小组赛/晋级/金靴/该队的比赛市场。

候选打分（结构相关性强度 × 流动性 × 成本），过滤掉：空/单边簿、结算时间晚于持仓的、深度吃不下用户对冲规模的。

### 2.3 订单簿/价格抓取

```
GET /book?token_id=<tokenId>        // ⚠️ bids 升序 / asks 降序，取回后必须归一化
GET /midpoint?token_id=<tokenId>
POST /books   body:[{token_id},...] // 批量(~500/10s)，一次对冲分析(持仓腿+~20候选腿双边≈40 token)一发搞定
```

```ts
// ⚠️ 数据边界唯一负责：parse 字符串→数字 + 归一化排序 + 退化簿守卫
function normalizeBook(raw): Book {
  const bids = raw.bids.map(l => ({price:+l.price, size:+l.size})).sort((a,b)=>b.price-a.price);
  const asks = raw.asks.map(l => ({price:+l.price, size:+l.size})).sort((a,b)=>a.price-b.price);
  const bestBid = bids[0]?.price ?? NaN, bestAsk = asks[0]?.price ?? NaN;
  // 退化簿守卫(0.999/0.001 占位)：不要当成"有效最优价"
  if (bestAsk >= 0.99 && bestBid <= 0.01) throw new Error('CANNOT_PRICE: degenerate book');
  return { bids, asks, midpoint: (bestBid + bestAsk) / 2 };
}
```

### 2.4 专有历史抓取（护城河，第 1 天就跑）

因为结算后 prices-history 退化到 12h+，必须在赛中抓存。**v1 纯靠 cron**（无 WS）：

| 档 | 市场 | 频率 | 来源 |
|---|---|---|---|
| Hot | 60 个夺冠结果 + 进行中比赛 token | 1 分钟 | 批量 /books |
| Warm | 晋级/小组/金靴(~100 token) | 5 分钟 | 批量 |
| Cold | 其余 props | 15 分钟 | 批量 |

速率预算：只抓 YES token 画曲线（NO=1−YES）→ ~370–600 token；批量 500/10s 上限下有 **>70× 余量**。瓶颈是 payload 大小和 DB 写入，用分块 + 批插解决。存 `book_snapshot`（best_bid/ask、midpoint、spread、1%/5% 深度摘要、Hot 档留完整 ladder ~14 天后丢），物化成 `price_ohlc_1m` 供画图。

### 2.5 缓存/速率/降级
Redis stale-while-revalidate + 单飞合并（N 个用户看西班牙 → 1 次上游 /book）。令牌桶设到各上限的 ~70%。Cloudflare 是**节流不拒绝**，所以靠客户端主动限速 + 满抖动指数退避 + 每主机熔断。降级阶梯：陈旧缓存+时间徽章 → 退回 midpoint 仅供显示但**禁用 go/no-go** → 空/单边簿标该腿不可执行 → 全挂则 Neon 快照只读模式。**"算不出可成交价"和"这个对冲不值"都是合法设计输出，所以降级是安全的。**

---

## 3. 模块二：净成本引擎（净成本引擎 —— 核心 IP）

> 整个产品"诚实"的根。**唯一一份费率函数住在这里**，sizing/correlation 调它、绝不自己重算。

### 3.1 走簿求可成交价

```ts
export function walkBookBuy(book: Book, targetShares: number): FillResult {
  const asks = book.asks;                 // 已在数据边界归一化为升序
  let remaining = targetShares, cost = 0, worst = 0;
  for (const lvl of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.size);
    cost += take * lvl.price; worst = lvl.price; remaining -= take;
  }
  const filled = targetShares - remaining;
  const avg = filled > 0 ? cost / filled : null;
  return { filledShares: filled, unfilledShares: remaining, avgFillPrice: avg,
           worstFillPrice: worst, midpoint: book.midpoint,
           slippagePerShare: avg && avg - book.midpoint,
           capacityHit: remaining > 0 };
}
```

滑点拆成两块给用户看：**穿价差成本** =(bestAsk−mid)×shares；**走簿深度滑点** =(avgFill−bestAsk)×shares。

### 3.2 费率函数（唯一权威，已核验）

```ts
export const FEE_RATE_SPORTS = 0.03;
/** 买入 taker 费(USD)。卖出免费。p=0.5 处峰值 0.75% of notional。 */
export function takerFeeUsd(shares: number, p: number, side:'buy'|'sell'='buy'): number {
  if (side === 'sell') return 0;                       // 卖单免费(已核验)
  const fee = shares * p * FEE_RATE_SPORTS * p * (1 - p);
  return fee > 0 ? Math.max(fee, 0.0001) : 0;
}
export const feeFracOfNotional = (p:number) => FEE_RATE_SPORTS * p * (1 - p); // 0.75%@0.5, 0.39%@0.85
```
验证：100 份 @ $0.50 → `100×0.5×0.03×0.25 = $0.375` ✓（匹配 Polymarket 官方示例）。
**关键认知**：我们推荐的腿大多在 p≈0.85 或 0.15，费只有 ~0.39%。**主导成本是价差+滑点，不是费**；最大的成本杠杆是"挂限价单"（maker 免费 + 不付价差）。

### 3.3 总成本与收益

- **持有到结算（WC 的默认情形）**：无退出成本，$1 兑付 0 费。`总成本 = Σ 各腿入场成本`。
- 各腿入场成本 = (avgFill−mid)×shares + takerFeeUsd。
- **收益**：把用户 P&L 建成对"一次性结算"的离散分布 `{(P&L_ω, q_ω)}`（q 是 de-vig 后的概率，见 §4）。算 `σ(P&L)`、`MaxLoss`、`CVaR_α`、`P(亏损)`。
  - `payoff[ω][leg]` = 该腿在结果 ω 下是否兑付 $1，由 bracket/path 结构**确定性**构造 —— 同一结果分区上的腿，给定 q 后联合分布**精确**，无需估协方差。

### 3.4 唯一 go/no-go（由 lib/sizing 拥有，见 §4.4）

```
η = 移除的风险($) / 总对冲成本($)
if 总成本 > MaxLoss 减少量:  NO_GO  (COST_EXCEEDS_BENEFIT，比能防的最坏损失还贵，严格不理性)
elif η < η_min:             NO_GO  (不值)
elif 残余风险可接受:         GO     (含半 Kelly 仓位)
else:                        PARTIAL(更小的 k% 对冲能过线)
```
⚠️ **统一一个收益基准**（推荐 MaxLoss 或 CVaR，对散户最直观），`η_min` 只定义一次（CVaR/σ 基准下默认 3.0）。相关性模型的一阶条件只当**预筛**，不当第二个裁决。**🔴 NO_GO 是一等输出**：明说"同盘对冲扣 vig 后是负 EV，别动，或挂限价 X 试更便宜的成交"。

### 3.5 worked example（$1,000 西班牙 YES @0.153）
6,536 份；西班牙输则 −$1,000（MaxLoss），σ≈$2,353。买 ~640 份 NO 把最坏损失砍半：价差+滑点≈$2.07，费≈$1.91，**执行成本≈$4（占 ~$500 的 0.8%，便宜）**。但结构性代价是付 $0.85 保 $1（那 $0.15 是 vig，远大于费）。σ 降到 ~$1,400（约 −40%）。→ 🟢/🟡 **GO 带注**："砍半最坏损失只花 ~$4 价差+费，但你在为每 $1 下行保险付 $0.85 —— 这 $0.15 是市场 vig 不是手续费。只想要心安的话，挂 NO 限价 0.848，省掉价差和 $1.91 的费。"对比 $40 小仓：成本下限(冷门 5c 价差)≈$2=5%，移除约 $1.50 风险 → η<1 → 🔴 不值，别动。

---

## 4. 模块三：相关性 + 仓位模型（相关性模型）

> 核心论点：**一次性结算、短噪声序列估不出协方差，所以我们从不估 —— 每个相关性都从价格+逻辑解析推导，或由结构化因子先验填补，并标注出处。** 这把"协方差弱点"变成"可解释强点"。

### 4.1 ⚠️ 先补一个被漏掉的关键步骤：de-vig（在关键路径上）

60 个 YES 价格之和 = 1 + overround，必须归一化成真实概率 `q` 才能算 σ/CVaR/Kelly。

```ts
// lib/correlation/devig.ts —— 约 20 行，但没它整条链算不动
export function devig(yesPrices: number[]): number[] {
  const s = yesPrices.reduce((a,b)=>a+b,0);
  return yesPrices.map(p => p / s);          // 比例归一化(可选 power-method)
}
```
`q` 必须进 `CorrelationResult`，下游共用。

### 4.2 结构相关图（边是逻辑关系，不是拟合权重）

对每队 i 的单调阶梯指标：`G_i`(赢小组) `A_i`(晋级) `Q_i`(进八强) `S_i`(进四强) `F_i`(进决赛) `W_i`(夺冠)；外加 `E`(欧洲队夺冠，超集)、`Match_ij`、bracket 左右半区。

五条约束 = 全部相关性骨架：
1. **单调阶梯（嵌套）**：`p(W)≤p(F)≤p(S)≤p(Q)≤p(A)`。注意 `W ⊄ G`（可作为小组第二夺冠），W 与 G 是 A 下的正耦合兄弟。
2. **互斥/negRisk**：`Σ W_i=1`，任意两队夺冠负协方差。
3. **子集/超集**：`{W_西} ⊆ {E}` → 强正相关。
4. **bracket 路径**：决赛每半区一队；同半区两队至多一队进决赛 → 额外负耦合。
5. **比赛互补**：`Match_ij = 1−Match_ji`（相遇条件下完美 −1）。

### 4.3 解析推导相关性（不碰历史协方差）

二元 X,Y：`ρ = [p(X∧Y) − p(X)p(Y)] / √[p(X)(1−p(X))p(Y)(1−p(Y))]`。边际取自价格，**联合取自结构**：

| 情形 | 闭式 | 例（实盘价） |
|---|---|---|
| **互斥**(西班牙 vs 法国夺冠) | `ρ = −√[p_i p_j /((1−p_i)(1−p_j))]` | −0.191 |
| **超集**(西班牙 vs 欧洲队夺冠) | `ρ_sub = √[p_m/(1−p_m) · (1−p_b)/p_b]` | +0.332，**最干净的对冲信号** |
| **阶梯**(西班牙夺冠 vs 进决赛) | 同超集，basket=F | +0.65（同队阶梯是**差**对冲，同向兑付） |
| **兄弟**(西班牙夺冠 vs 赢小组H) | 用 `p(W∧G)=p(G)p(W\|G)` | +0.13（**差**对冲，同向，剔除） |

每个候选对产出"带符号+量级+触发规则(EXCLUSIVE/SUBSET/LADDER/SIBLING/MATCH)"的相关性，**规则注解就是 LLM 渲染的"为什么"**。

### 4.4 因子先验 + 收缩（填补无逻辑关系的对）
对没有逻辑关系的散对，用 3 因子结构先验（强度因子/区域因子/半区因子，载荷手设非回归）。合并：解析能精确钉死的格子 `δ=1`（标 `ANALYTIC`）；只有因子说话的 `δ→0`（标 `PRIOR` + 宽误差带）。用 Ledoit-Wolf 机制只为保证结果良态 PSD（特征值裁剪投影），不做数据驱动的 δ。**每个格子带出处标签**，流入解释层。

### 4.5 对冲构建（吃净成本引擎的输出）
变量 `x_j≥0` = 各候选腿买入份数（无做空：用买 NO / negRisk 补集篮子实现）。带成本预算的均值-方差：`max E[P] − (λ/2)Var[P] s.t. c(x)≤κ`。因为内盘对冲负 EV，`E[P]<0`，目标实质是"花钱买降方差，值不值"。腿 j 进基的一阶条件：`−ρ_0j σ_0 σ_j > (1/λh)·∂c_j/∂x_j`。**没有腿能过线 → NO_GO**（"只有跟你相关到能对冲的市场都太薄/太贵，成本吃掉保护，持有"）。

### 4.6 仓位：分数/半 Kelly（对相关二元注）
枚举联合情景（≤10 腿全枚举；否则结构化蒙特卡洛 50k 次，从 negRisk 多项式抽一个夺冠者再按条件路径传播，**每个样本都满足约束 1–5，绝不从拟合协方差抽样**）→ 最大化 `E[log W]` → 三重缩减：(a) 半 Kelly `×0.5`；(b) 协方差不确定性 haircut `γ`（按该腿用了多少 `PRIOR` 格子）；(c) negRisk convert 降抵押后重算成本再跑。输出**仓位区间**（"买 90–140 份，点估 115"）。若 go/no-go 符号在区间内翻转 → 降级 NO_GO/不确定。

### 4.7 worked example（持西班牙夺冠 1,000 份）
候选：①法国夺冠 −0.191(好但散)；②欧洲篮子补集(广、贵)；③西班牙赢小组 +0.13 **剔除**；④四大对手 NO 篮子(negRisk convert，强负、深度favorite躲开 50/50 费峰)→ **最优**。半 Kelly → 买 ④ ≈ $520–640(点 $575)。→ 🟢 **GO(温和)**："在西班牙最可能输的方式(别的热门夺冠)里赔付，且这些 NO 是深度 favorite 基本躲开 0.75% 费峰。它不赚钱(内盘对冲负 EV)，是花 ~$575 买约 X% 降方差。只用了互斥这一精确关系，没拟合任何历史相关性。深度跌破 ~$5k/边就重查。"

---

## 5. 模块四：LLM 解释层

**角色：只解释确定性引擎算出的数，绝不发明数。** 输入是 `Decision.facts`（由唯一 formatter 从 `Decision` 生成的预格式化字符串），用 AI SDK `generateObject` + 纯散文 Zod schema 输出。守卫：
1. 生成后做数字 token 提取，任何不在 `facts` 里的数字 → 丢弃，回退确定性模板。
2. ⚠️ **加一个单测**：`facts` 字符串必须由单一 formatter 从 `Decision` 派生（防上游格式化 bug 被 LLM 忠实复读）。
3. ⚠️ 系统提示**禁止比较性数量词**（"大约翻倍""三分之二"这类无数字的量化幻觉），只允许定性词（"降低""减少"）。

模板优先上线，LLM 是可换的锦上添花。

---

## 6. 端到端关键路径

```
仓位输入 → resolve(§2.1) → 候选池(§2.2) → 批量归一化 /books(§2.3, 退化簿守卫)
→ devig 得 q(§4.1) → 结构相关性(§4.2-4.4) → 各腿走簿净成本(§3) → 半 Kelly 仓位(§4.6)
→ 唯一裁决 Decision(§3.4/§4.5) → 模板/LLM 解释(§5) → UI(并排显示中间价 vs 可成交价)
旁路：Cron 每分钟快照(§2.4) 持续累积护城河
```

⚠️ **结构种子文件**（关键路径，没它只有内盘补集对冲能跑）：`wc2026-structure.ts`，手工映射 60 队 → 大洲/小组/(抽签后)bracket 半区，约 60 行。互斥关系从 negRiskMarketID 自动推导。

---

## 7. MVP 范围裁剪与 5 周计划

**最小可演示（砍到确定性主干 + 只在最深流动性市场）：**
- 只做**夺冠单 negRisk 事件**(60 结果，唯一可靠深簿)。一种对冲：**内盘补集**(你队的 NO / 对手 NO 篮子，靠 negRiskMarketID 自动推导，无需种子)。一个仓位："西班牙夺冠"。
- demo 流程全确定性、无 WS、无 Python、LLM 可选：解析 → 批量 /books(退化簿守卫) → 走簿真 VWAP + 0.75% 体育费 + **并排显示中间价 vs 实付**(诚实成本的 wow) → de-vig 得 σ/MaxLoss 前后 → **唯一裁决**，且**同时展示一个 GO 和一个 NO_GO**(如西班牙 vs $40 冷门)让"不值"可见地成为一等输出 → 模板解释 → 自抓 cron 序列画的价格图(证明护城河在累积)。
- **明确砍掉**：WebSocket、赛中秒级重定价、欧洲超集/条件阶梯对冲(要种子)、金靴/晋级/props(薄簿)、钱包导入、合规地理门(留免责声明文案)、Kalshi、Python。

| 周 | 交付 | 解锁 |
|---|---|---|
| 1 | 数据层 + cron 护城河 + negRisk 自动互斥关系 | 数据从第 1 天累积 |
| 2 | 净成本引擎 + **唯一费率函数**(先把数搞对) | 去掉最大正确性风险 |
| 3 | de-vig + 相关性(仅内盘) + sizing + **唯一裁决** | 端到端可算 |
| 4 | UI + 模板解释 + (有余力)LLM | 可演示 |
| 5 | 加固、(领先则)第二种对冲、录 demo | — |

> 5 周可达**仅当** WS 砍掉、对冲宇宙裁到内盘。多事件结构模型(§4 的招牌例子)是第 6 周+ 的活。

---

## 8. 合规 / 商用设计
- ToS 是"个人非商用"许可 —— **按需读取、不批量转发**原始数据；只存我们派生的时序。追求 Polymarket dev 渠道的商用许可（其 2026/2 收购 Dome，对 builder 友好）。
- 收费的**个性化** per-position 建议可能触发 CFTC CTA 注册（Rule 4.14(a)(9) 只豁免非个性化/标准化建议）。架构支持一个"教育/标准化"模式开关 + **先服务非美用户**。

## 9. 风险（排序）
1. **平台风险**：Polymarket Combos(2026/6/10 宣布)/原生组合视图可能商品化你的 wedge。→ 用诚实净成本引擎 + 跨平台(Kalshi)做难复制的差异。
2. **薄簿**：长尾不可成交 → 容量门 + 退化簿守卫，v1 只做深簿。
3. **赛后断崖**：7/19 后流量骤降 → 第 1 天就按全年多垂类设计 + 一次性赛事通行证。
4. **数据 schema 漂移**：字段名/JSON 字符串格式 → `raw jsonb` 兜底 + 边界 parse 单测。

---

## 模块五：执行层 `lib/execute`（可选一键执行 —— L1 深链 + L2 非托管）

> 设计铁律：**私钥永远在用户手里,资金永远在用户钱包,我们只构造订单 + 中继用户已签的订单。L3(托管/资金池/自动 bot)永久禁止。** 合规边界见单独文件 [HedgeAdvisor-Execution-Compliance.md](HedgeAdvisor-Execution-Compliance.md) ——**动手前先和律师过那一页。**

### 5.0 经核验的"执行层地面真相"（先读,标 🔴 处照搬会丢钱或编译不过）

对 Polymarket 官方文档 / SDK 仓库 / PolygonScan / CFTC / FinCEN 对抗式核验(2026-06-15):

| 事实 | 真相 | 注意 |
|---|---|---|
| **🔴 抵押物是 pUSD,不是 USDC.e** | 2026-04-28 cutover 同时把抵押从 USDC.e 迁到 **pUSD**(1:1 USDC 背书,6 位小数)。V2 订单用 pUSD 结算,ERC20 `approve` 要批 **pUSD**;只持 USDC 的用户得先 **wrap**(USDC→pUSD) | ⚠️ 最危险的错。**绝不硬编码 pUSD 地址**(候选地址和旧 Aave LEND 撞了)——从 `docs.polymarket.com/resources/contracts` 实时拉 + PolygonScan 核字节码/symbol。BUY 成本和授权 UX 都要按 pUSD 重写 |
| **🔴 CLOB V1 已废,只写 V2** | V1 签名订单在 **2026-04-28 ~11:00 UTC** cutover 后被拒,EIP-712 域 version 1→2 | 直接对 V2 写。SDK 包名 **`@polymarket/clob-client-v2`**(旧 `@polymarket/clob-client` 已废) |
| **🔴 客户端直发 CLOB(架构A)大概率不行** | clob.polymarket.com **屏蔽浏览器跨域**请求 | 默认按**架构 B(瘦中继)**设计:服务器只**原样转发**已签订单,不落库 secret/签名,仍非托管。架构 A 当"待证伪"而非默认 |
| **SDK 形态** | viem-based(非 ethers)。导出类是 **`ClobClient`**(不是 `ClobClientV2`),**选项对象**构造 `{host,chain,signer,creds,signatureType,funderAddress}` | ⚠️ 别手搓构造器/EIP-712 字段,**pin 版本后照 v2 README 抄** |
| 下单方法 | `createOrder`(限价)/`createMarketOrder`(市价)→`postOrder`;或 `createAndPostOrder`。批量 `postOrders`(≤15,**非原子结算**)。`OrderType`: GTC/GTD/FOK/FAK | 高 |
| **市价单 amount 语义** | FOK/FAK **BUY: amount=要花的美元数**;SELL: amount=份数 | ⚠️ 最易写错 |
| 鉴权两级 | **L1**=钱包签 EIP-712(域 `ClobAuthDomain`)派生 creds + 签每笔订单;**L2**=`{apiKey,secret,passphrase}` 做 HMAC-SHA256,五个头 `POLY_ADDRESS/POLY_SIGNATURE/POLY_TIMESTAMP/POLY_API_KEY/POLY_PASSPHRASE` | **核验确认的非托管根**:文档原文"即使有 L2 头,创建用户订单仍必须让用户签订单 payload"——所以 creds 单独不能动资金 |
| `signatureType` | EOA=0 / POLY_PROXY=1 / POLY_GNOSIS_SAFE=2 / POLY_1271=3 | 🔴 **MVP 只支持 EOA + Safe**:POLY_1271 有 `createOrDeriveApiKey` 不 EIP-1271-wrap 的 bug(#64-66),POLY_PROXY 前端生成的 key 也过不了 V2 鉴权(#339)。Magic/邮箱登录待修 |
| V2 订单结构 | 去掉 `taker/expiration/nonce/feeRateBps`,加 `timestamp`(ms)/`metadata`(bytes32)/`builder`(bytes32),费在撮合时链上收 | `builder` 是归因码,**核验能否填我们自己的**(对接 Dome/商用渠道有用)。别手搓 typehash,用 SDK |
| 合约地址(已 PolygonScan 确认) | CTF Exchange V2 `0xE111180000d2663C0091e4f400237545B87B996B`;NegRisk Exchange V2 `0xe2222d279d744050d28e00520010520000310F59`;NegRisk Adapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`;CTF(ERC1155) `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | 🔴 抵押物地址(pUSD)需另核;**上链前每个都 PolygonScan 再核一遍** |
| negRisk convert | `convertPositions`(NegRiskAdapter 上的**链上 tx**,用户签,不是 CLOB 订单):把 m 个 NO 折成 complement YES + 释放抵押 | NO 篮子省抵押的高级项,默认关 |
| **🔴 L1 深链不能预填订单** | 核验确认:polymarket.com **无任何 URL 参数**能预填 side/size/price,只能深链到 **`/event/{slug}`** 市场页 | ⚠️ **"pre-fill"这个词全删掉**(会误导律师评估)。L1 = 把人送到正确市场 + 在我们 UI 里把"买几份/限价多少"写清楚让他手填 |

### 5.1 分级与边界（密钥/资金住哪）

```
L0  纯建议(已有):只显示 Decision + 可成交订单,零跳转。
L1  深链:按钮打开 polymarket.com/event/{slug} 精确市场页;用户在 Polymarket 上自己下单确认。
    └─ 我们碰:URL。 不碰:密钥/资金/签名/下单。 → 零执行责任。无预填。
L2  非托管在场执行:用户连自己钱包 → 我们用净成本引擎输出构造 EIP-712 订单
    → 用户在自己钱包签 → 我们(瘦中继)把已签订单转发 CLOB。
    └─ 密钥:永远在用户钱包。 资金:永远在用户自己的 Polymarket 钱包。
       服务器:只过境转发已签字节 + 写回成交。从不持有 secret/私钥/资金。
L3  托管/资金池/自动 bot = 永久禁止。
```
**地理门(硬性)**:global Polymarket 屏蔽美国交易。**美国用户只放 L0/L1,且 L1 只深链到 Polymarket US 界面,绝不到 offshore**(facilitating 美国人上 offshore 正是 2022 年那 $1.4M 罚单的违规)。L2 对美国用户**不渲染**(fail-closed 退回 L1)。OFAC 辖区整体拦。

### 5.2 L1 设计（深链 + "照这个下单"卡片）

```ts
// lib/execute/deeplink.ts —— ⚠️ 核验:只能到 /event/{slug},无订单预填参数
const PM = 'https://polymarket.com';
export function buildMarketDeepLink(eventSlug: string, utm?: string): string {
  const u = new URL(`${PM}/event/${eventSlug}`);   // 唯一确认有效的路径
  if (utm) u.searchParams.set('utm_source', utm);  // 我们自有的归因参数(非 Polymarket 的)
  return u.toString();
  // VERIFY: negRisk 子结果是否有 /event/{slug}/{marketSlug} 或 outcome 锚点(上线前真机点验,别猜)
}
```
按钮旁渲染**"照这个下单"卡片**(因为不能预填):`买 NO·法国夺冠 / 约 640 份 / 限价 0.848 / 预计 ~$543`,带"复制份数""复制限价"按钮 + "打开后:选 No→填份数/限价→在 Polymarket 确认。我们不接触你的资金、密钥或下单。" 数字来自 §5.4 的 `requote()`,不是推荐时的旧数。多腿 = 多卡片 + 多深链。

### 5.3 L2 设计（非托管在场执行）

**钱包连接(wagmi + viem)**:MVP 首选**浏览器注入钱包(EOA,signatureType=0)** + **Polymarket Safe(=2)**(很多老用户资金在 Safe;`funder`=Safe 地址,`signer`=控制它的 EOA,`ClobClient` 单独传 `funderAddress`)。WalletConnect 作 fast-follow。Magic/POLY_1271 砍掉(见 5.0)。

凭据派生(零托管):
```
[浏览器 'use client'] 用户钱包在场
 1) wagmi 连接 → 拿 signer(viem WalletClient)
 2) 照 v2 README 构造 ClobClient(选项对象: host/chain=137/signer/signatureType/funderAddress)
 3) creds = await client.createOrDeriveApiKey()  → 弹窗让用户签 ClobAuthDomain EIP-712(L1)
 4) 🔴 secret 只留客户端内存(sessionStorage,关页即弃),永不发服务器。L2 HMAC 头在客户端算。
```
**中继架构 = B(默认)**:客户端把**已签订单 + 临时 L2 头**发 `/api/execute/relay`,服务器**原样转发** clob.polymarket.com,**不落库 secret/签名**(仅过境)。仍非托管。(架构 A 客户端直发因 CLOB 跨域屏蔽大概率不可行,当待证伪。)

一次性授权(`lib/execute/allowances.ts`):交易前对 **pUSD** 做 ERC20 `approve` + 对 **CTF(ERC1155)** 做 `setApprovalForAll`,**spender = Polymarket 的 CTF Exchange / NegRisk Exchange / NegRisk Adapter**(按本次对冲实际用到的最小化),**绝不批给我们自己的地址**。客户端用 viem `publicClient` 免签 `allowance()`/`isApprovedForAll()` 检查,缺啥补啥,用户在自己钱包签上链。文案:"给 Polymarket 交易合约的标准一次性授权,不转出你的资金,我们不经手。"(🔴 只持 USDC 的用户还需先 USDC→pUSD wrap,VERIFY wrap 合约。)

### 5.4 点击即重报价（接净成本引擎,复用不重写）

```ts
// lib/execute/requote.ts
import { walkBookBuy, takerFeeUsd } from '@/lib/netcost';   // 复用唯一费率函数
import { normalizeBook } from '@/lib/data';                 // 复用 parse+归一化+退化簿守卫
const DRIFT_CONFIRM = 0.02, LIMIT_BUFFER = 0.005;
export async function requote(ref, shares, recoPayUsd) {
  const book = normalizeBook(await fetchFreshBook(ref.tokenIdNo)); // 点击时拉新书,不吃缓存
  const fill = walkBookBuy(book, shares);
  const fee  = takerFeeUsd(fill.filledShares, fill.avgFillPrice, 'buy');
  const estPayUsd = fill.filledShares * fill.avgFillPrice + fee;
  const driftPct  = recoPayUsd > 0 ? Math.abs(estPayUsd - recoPayUsd) / recoPayUsd : 1;
  const limitPrice = Math.min(0.999, +(fill.worstFillPrice * (1 + LIMIT_BUFFER)).toFixed(3));
  return { estPayUsd, recoPayUsd, driftPct, needsConfirm: driftPct > DRIFT_CONFIRM,
           limitPrice, resolved: ref.resolved, capacityHit: fill.capacityHit };
}
```
UI:"你将支付 **~$543**(推荐时 $538,+0.9%)"。漂移超阈值或容量不足 → 强制"我确认新价"。**签的是限价单**(limit=`limitPrice`),签到撮合间书再动用户也拿不到更差价(拿不到就不成交,进失败分支)。

### 5.5 多腿/篮子执行（无原子多单 —— 诚实状态机）

CLOB 不支持原子多单,逐腿签+逐腿提:
```
对每条腿(顺序): requote → 漂移超阈值要重确认 → buildOrder(limitPrice) → 用户签 → submit
  ├─ 成交/部分成交 → 记 FillRecord,进下一腿
  ├─ 用户拒签 / 提交失败 → 停止后续,【不假装回滚】(已成交无法 un-fill)
  └─ 立即用已成交的腿重算 riskAfter(复用净成本/相关性引擎),展示"你现在真实在哪"
```
失败 UI 诚实呈现:`✅ Leg1 法国 NO 成交 640@0.846 −$542 / ❌ Leg2 失败(书变薄) / 你现在的实际敞口:[重算] / 选项:①重试 ②接受现状 ③卖掉 Leg1 解除(卖单免费,吃价差)`。**已成交腿立即重算,绝不展示推荐时的理想态。**

### 5.6 模块契约（继续从 `lib/types` 取）

```ts
export type ExecLevel = 'L0'|'L1'|'L2';
export type SignatureType = 0|2;                 // MVP 仅 EOA / Gnosis Safe
export interface WalletCtx { address:`0x${string}`; funder:`0x${string}`; signatureType:SignatureType; chainId:137 }
export interface FillRecord { ref:MarketRef; orderId?:string;
  status:'FILLED'|'PARTIAL'|'FAILED'|'REJECTED'|'USER_CANCELLED';
  filledShares:number; avgFillPrice?:number; paidUsd?:number; takerFeeUsd?:number; ts:number; error?:string }
export interface BasketResult { decisionId:string; fills:FillRecord[]; completed:boolean; aborted:boolean;
  riskAfterActual?:Decision['riskAfter'] }     // 用实际成交腿重算
```
运行位置:**客户端**('use client') —— 连钱包/派生 creds/构造+签订单/编排 `executeHedgeBasket`(逐腿跑 requote+签+提,UI 钩子收确认);**服务器** —— `/api/execute/relay`(架构 B 原样转发,不落 secret)+ `/api/execute/fill`(把成交写回 `user_position`,后续 go/no-go 基于真实持仓)。

### 5.7 上线顺序
1. **L1(深链)= MVP,所有合规辖区**(美国→Polymarket US 界面;非美→global)。表面最小,靠 §5.2 + 地理门即可。
2. **L2(非托管中继)= 快速跟进,仅非美**,gated on 合规文件 §8.1 的托管意见 + Polymarket 商用/API 条款 + 中介分析 + 制裁筛查。
3. **L3 = 永不。**

---

*本方案的所有 API/费率/订单簿/下单/合约事实经 Polymarket 实盘端点 + 官方文档 + PolygonScan 对抗式核验(2026-06-15)。标 ⚠️/🔴 处为核验抓出、照搬会出 bug 或丢钱的点。执行层动手前务必:(1) 从官方 contracts 页实时拉 pUSD 及各合约地址并 PolygonScan 核字节码;(2) pin SDK 版本照 v2 README 抄构造器;(3) 过一遍合规边界文件并找律师。*
