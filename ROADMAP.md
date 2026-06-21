# HedgeAdvisor — Roadmap(优先级 + 依赖)

> ⚠️ 下面"## 状态总览"及之后是 2026-06-21 之前的历史变更日志(记录的对冲模型是已被否决的"做空自己"
> 版本:补集 / reach-final NO / 对手篮子 / express↔protect)。**当前目标见本节,以本节为准。**
> 北极星与表面图详见 [REFOCUS.md](REFOCUS.md) 与 [PRODUCT.md](PRODUCT.md)。

## 现状与当前目标(2026-06-21)

- **正和、不做空、不预测。** 对冲腿必须是"别的事件上、你这注没中时反而可能获益"的独立正注(负相关 / 去相关),
  最好两个都中、最差只中一个。**彻底移除了所有做空自己的逻辑**(买本方 NO 补集、对手篮子、跨场馆等价 NO、
  reach-final NO 蕴含腿)。
- **双场馆。** Polymarket + Kalshi 并存;`/link` 做跨场馆同结果"哪边更便宜买 YES"的成本比较(不是对冲)。
- **世界杯期间上线 ⇒ 校准来不及成熟**(一届杯赛≈一个 cluster,需 ~20 样本/分支),所以上线主要靠
  低置信的推理逻辑层(Qwen 机制图 + φ),严格从属于可信层;Optimal 层经常为空,这是诚实的一类答案。
- **表面已收敛(无重叠):**

  | 表面 | 职责 | 引擎 | 做空? |
  |---|---|---|---|
  | **Hedge** `/hedge` | 唯一对冲面:一注 → 正和伴随注,Optimal + Exploratory 两层 | `discoverRelations` | 从不 |
  | **Combo** `/combo` | 多腿 parlay 真相计算器(真实成本/公允价/复利 vig/结构不可能) | `runCombo` | 从不 |
  | **Cross-venue** `/link` | 同结果在两场馆比价,选更便宜的执行场馆 | `relateCrossVenue` | 从不 |
  | **Markets** `/markets` | 只读实时行情 | `gammaGet` | 从不 |

  本轮合并/删除:`/protect`+`/discover`(同引擎重复)合并为 **/hedge**(旧路由 307 跳转);`/plan` 彻底下线
  (其 protect 端会做空);删除旧 `/hedge` 做空页 + `lib/hedge` maximin 引擎 + `/api/protect`/`/api/hedge`/
  `/api/plan` + 孤儿 `/api/association`。
- **校准器准确度(2026-06-21 评测,6 个夺冠锚,45 条推理关系):** 关联性精度 71%、相关性符号正确率 36%、
  正和对冲有效率 2%(夺冠类锚几乎不存在干净的正和跨事件对冲——会负相关的都是同赛事对手=被当做空剔除,
  不同赛事的多是同国球员 prop=正相关同生共死)。引擎对此**诚实**(5/6 给 NO_ACTION)。已修:`/hedge` 把
  `相关性≥0` 的市场挡在伴随层外(它们是放大不是对冲)。待改进:球员→国家名册去错;去掉匿名占位行;
  "对冲"标签强制要求严格负相关;把候选宇宙扩到世界杯之外以出现真正去相关的跨域对冲。
- **已知死代码(待清):** `lib/pipeline` 的 `runHedge`/`runPlan` + `lib/plan` + `complementEdge`/`rivalEdge`
  现已不可达(路由已删),但仍在源码中;清除是单独的、需验证的收尾(与保留的 `runCombo` 同在一个 867 行文件里)。

---

> 历史(已被否决模型)变更日志如下,仅作记录。

> 当前指令:**先把世界杯这一块做到最精确**,其余按下面次序排。
> 已完成:世界杯 MVP(诚实补集 + 多选项菜单,29 测试通过、build 干净、实盘跑通)。
> 已出设计、待批/待建:跨事件(reach-final)、跨域 A(政治滩头堡)。

## 状态总览

| 模块 | 状态 | 文档 |
|---|---|---|
| 世界杯 MVP(补集 + 多选项菜单) | ✅ 已建、已测、实盘通过 | `HedgeAdvisor-MVP-TechSpec.md` |
| 实时中点定价 + 按 bankroll 的 Kelly 仓位 | ✅ 已建、已测 | — |
| 下注方案流程(`/plan`:选注 + 预算 + λ 滑块) | ✅ 已建、已测、实盘通过 | `HedgeAdvisor-BetPlan-Design.md` |
| 精确比分(诚实单注,逐格深度闸) | ✅ 已建 | BetPlan §A2 |
| 带价格上限的走簿(假墙防护) | ✅ 已建、已测 | BetPlan §4.1 |
| 跨域(通用解析器 + 政治等任意 negRisk 事件) | ✅ 已建、已测、实盘通过(Newsom 2028) | `HedgeAdvisor-CrossDomain-Design.md` |
| 跨事件对冲(reach-final NO,结构化蒙特卡洛) | ✅ 已建、已测(回归基准)、菜单集成 | `HedgeAdvisor-CrossEvent-Design.md` |
| L1 深链执行 | ✅ 已建 | TechSpec 模块五 |
| L2 非托管执行 | 🔒 脚手架 + fail-closed 闸(需律师才能上线) | `HedgeAdvisor-Execution-Compliance.md` |
| 因果/跨域关联(方向 B) | ❌ 明确不做(假精度风险) | — |

### 细化项(已全部完成,经对抗式审查修复闭环)
- ✅ 每事件费率:按市场实读 `feeSchedule`(体育 0.03 / 政治 0.04 / 加密 0.07)。
- ✅ 大小球(over/under N.5)+ BTTS 单注(深盘,"under" 买 NO,live 去 vig)。让分按设计推迟(与比分语法冲突)。
- ✅ 政治跨事件静态嵌套表(`提名⊂总统`),与足球 reach-final 统一为一条通用阶梯对冲 + 价格单调性闸。
- ✅ 部署就绪:`DEPLOY.md`(env 清单 + 预部署清单全绿)。实际 `vercel --prod` 需你的账号执行。

### 本轮新增(对标成熟产品 + 你点名的两项)
- ✅ **精确比分多腿对冲方案**:`/plan` 选 `X vs Y a:b` 现在用整张比分网格(17 格的互斥分区,含"任意其他比分"兜底)`buildPlan` 出一个真正的多腿对冲,锚定你选的那格;滑块在"全押你这格 ↔ 摊到更可能的比分"之间调。`resolveExactScoreGrid` 用 live 中点对整张网格去 vig。(旧版只给单注。)
- ✅ **同时押注数量(maxLegs)过滤器**:总金额之外新增"买几注"。永远保留你的选注,其余名额给配额最大的几格,再把预算重标定回满额。API(`/api/plan` zod `maxLegs`)+ `/plan` UI 输入 + 引擎 `capLegs` 全打通。
- ✅ **诚实保底闸(plan 版 NO_GO)**:当摊开覆盖了几乎整张盘、每个结局都亏(`maxGain ≤ 0`)时,明确告知"无论如何都亏 ≈ vig,这不值得对冲,请减少注数"。(实盘复现:60 刀 Protect 不限注 → 买满 17 格、100% 亏 ≈ -19%;maxLegs=2 → 24% 盈利概率、真实上行。)
- ✅ **公允价 / CLV 行**:每腿显示去 vig 公允价 vs 你实际付的价,差额=你吃的 vig+spread;并给保护性限价。这是 gap 分析里最契合"诚实成本"定位的一项。
- ✅ **可复制的顺序下单清单 + 每腿深链**:`/plan` 给"按顺序买,带具体金额/限价"的清单 + 一键复制 + 每腿 Polymarket 深链。
- ✅ **实盘自检**:`test/live-verify.test.ts`(默认 skip,打真实 API)。已验证:① "西班牙 vs 佛得角 0:0" 不是真实赛程 → 诚实拒绝并给真实建议(二者同组但不直接对阵:西/沙、乌/佛、佛/沙、乌/西);② 真实比分注出逻辑自洽、真实有效的多腿对冲(EV≤0、付价≥公允价、概率分区∑≈1、深链合法);③ maxLegs 实盘生效。

### UI 改版 + 真实市场 typeahead(2026-06-16,用 /impeccable 完成)
- ✅ **浅色 Notion 风改版**:白底 + 发丝边框 + 克制近单色 + 一点蓝(`#2b66d9`),系统字体,克制动效。tokens 在 `app/globals.css`,设计依据见 `DESIGN.md` / `PRODUCT.md`。copy 去掉所有 em dash。新增 favicon `app/icon.svg`。
- ✅ **关键词 typeahead(只出真实市场)**:`components/MarketSearch.tsx` + `/api/search` + `lib/polymarket/search.ts`。`/plan` 搜真实世界杯赛程(选中填 "A beats B",带前缀匹配);`/` 搜真实 negRisk 事件(Gamma `/public-search`),第二步列该事件的真实结果选项,点选后带 event slug 调 `/api/hedge` 在该事件内对冲(不再跨域重搜)。
- ✅ 本地实测(Playwright,真实 API):两页 typeahead 出真实市场、选中可用、改版渲染正常;`npm test` 71 通过 + 3 skip;typecheck / build 全绿。

### estimate 回测校准(2026-06-17)
- ✅ **校准指标库** `lib/estimate/calibration.ts`(Brier、log-loss、calibration-in-the-large/bias、ECE、Brier skill、可靠性分桶),纯函数 + 6 单测。
- ✅ **回测脚手架** `test/backtest-calibration.test.ts`(默认 skip,手动跑;打真实 API)+ `fetchPricesHistory`(CLOB `/prices-history`):拉**已结算**市场,取结算前 ~7 天的去 vig 价 vs 真实结果。
- ✅ **真实回测结论(2026-06-17 跑通,记 `CALIBRATION.md`)**:
  - 边际校准好:n=120,**Brier 0.013 / ECE 0.032 / Brier-skill 0.60** → Polymarket 价格是可信的边际输入(样本偏冷门、高位桶样本少)。
  - **de-vig 三方法(proportional/power/Shin)校准几乎无差**(Brier 差到小数第 4 位)→ **诚实修正**:Shin/power 价值在"偏斜/高 overround 盘的稳健性 + 透明展示方法",**不是**预测更准;不再宣称准确度提升。
  - 跨市场:15 对随机跨事件 独立预测 0.105 vs 实测 0.133(n 太小,无法区分噪声)→ 维持"只给区间不给系数"的设计;示意 ρ=0.25 方向合理。
- 复核:typecheck 干净、**101 测试通过 + 6 skip**(live-verify 3 + backtest 3)。

### 推测关联度 + 全代码审查(2026-06-17)
- ✅ **集成不确定性原语** `lib/estimate/ensemble.ts`(均值±std + 向 50% 收缩,MiroFish 配方当方法用,纯 TS、零 AGPL)。
- ✅ **诚实的跨市场联合估计** `lib/estimate/joint.ts`:每腿边际带=三种 de-vig 方法分歧;联合"全中"=独立 Πq + **精确 Fréchet 包络** + 高斯 copula 示意点(标 ρ)。接入 Combo 仅对**不同市场**的腿出,卡片标 "ESTIMATED, not analytic"。实盘验证 England⊆Europe 案例(独立低估、真值落区间顶)。9 个 estimate 测试。
- ✅ **多智能体全代码审查**(17 agents,4 维度→对抗式核验→汇总):0 P0 / 2 P1 / 7 P2。**两个 P1 已修**:① Combo NO 腿陈旧/分离盘口回退价可致 EV 显示为正 → `combo.ts` evFrac 钳到 ≤0 + `pipeline.ts` 把腿价**地板在公允价**(并标 capacityHit);② 互斥组合显示幻象 +gain → 互斥时 payoutMultiple/maxGain 归零。**全部 7 个 P2 已清**:Fréchet 标签改 "envelope (incl. marginal uncertainty)";`/api/requote` conditionId 加 max(80);`norm()` 抽到 `lib/polymarket/text.ts`(三处共用);`round2()` 抽到 `lib/sizing/util.ts`;plan/combo 页面改 `import type` 引用 `lib/types`/`lib/combo` 规范类型(消除漂移);`/settings` 去掉读 `process.env` 的配置存在性泄露(改静态文案);`lib/data/db.ts` 用 `Sql` 类型替掉 `as never`;删除死字段 `MarketRef.resolvedOutcome`。复核:typecheck/build 干净、95 测试通过、6 路由 200、plan/combo/settings 渲染正常。
- 详见审查报告(本轮 workflow 产物)。

### "只做3件事" 升级(2026-06-16,基于竞品+开源调研)
- ✅ **de-vig 升级**:`lib/correlation/devig.ts` 新增 **Shin**(内部交易者模型,恢复 z)、**power**(Σpᵢᵏ=1,二分求 k),`devigDetailed` 自动择优(Shin→power→proportional)。已接入 plan 结果分区、hedge 分区、**精确比分网格**(偏度最大、最受益)。UI 露出方法+参数("De-vig method: Shin (insider z=0.3%)")。13 个 devig 测试(含 favourite–longshot 方向)。
- ✅ **Combo Truth Check(旗舰)**:新 `/combo` 页 + `lib/combo/combo.ts`(纯函数,8 测试)+ `/api/combo`。走每条腿真实盘口 → 诚实算"自己逐腿拼的成本(Πprice)vs 公允(Πq)vs 复利 vig",可选粘贴报价做"折扣是否真实"判定。**同场互斥腿自动识别**(两条 YES 同一市场 → 永不可能命中,真实概率 0%)。实测:England+France 同夺冠 → 0%/不可能;Trump 腿模糊 → 诚实跳过。侧栏新增 Combo,三页加 "Combo check" tab。
- ✅ **search 升级**:接入 **uFuzzy**(单字符容错,"croatai"→Croatia 实测通过);加 **TTL(public-search 15s / fixtures 60s)+ 并发去重**应对 ~60 req/min 限流。保留 teamQuery + volume 排序。
- 决策依据:`COMPETITIVE`(本轮 5-agent 调研)——最大空缺=Polymarket 零售"诚实下单前成本 + GO/NO-GO",切入点 Combo Truth Check;de-vig 是唯一真正要紧的计算升级;走簿/Kelly 网格/CVaR 已够好别动。

### Dashboard 改版(2026-06-16,对着用户给的 mockup 做)
- ✅ **App shell**:左侧栏(Hedge/Plan/Markets/History/Settings)+ 顶部 tab + "Priced from live CLOB" 徽标。`components/AppShell.tsx`,`app/layout.tsx` 包裹。
- ✅ **Build plan 仪表盘**(`app/plan/page.tsx` 重写):统计行(Deployed/盈利概率/EV/最好/最坏/Max loss protected/Verdict)、Payoff scenarios(概率条)、Risk change(前后对比 vs 全押)、Plan construction(Fair/You pay/Gap/Shares/Limit/Est cost + 每行 Copy/Open)、Cost breakdown 堆叠条、Alternatives ranked、Market data & safety。Number of bets 步进器 + Express↔Protect 滑块。
- ✅ **新后端指标(全真实数据)**:`Plan.costBreakdown`(fair/spread/slippage/fee/vig,精确加总到 deployed)、`risk`/`nakedRisk`、`maxLossProtectedPct`、`verdict`+理由(诚实:绝不 GO)、`alternatives`、`bookOverroundPct`/`feeRatePct`。见 `lib/plan/buildPlan.ts`、`lib/types.ts`。
- ✅ Hedge 页并入 shell;Markets/History/Settings 为诚实占位页。
- ✅ 实测(Playwright,真实 API)+ build/typecheck/71 测试全绿。
- 📋 **还缺的真实功能清单** → `GAPS.md`(持久化/实时流/一键执行(法务门控)/Markets 扫描/更多投注类型)。

### gap 分析(对标 Polymarket/Kalshi/OddsJam/RebelBetting/同场过关)结论
- 关键发现:**引擎已成熟,缺口几乎都在"呈现层"**。本轮已补:公允价/CLV、顺序深链清单、注数过滤、保底闸。
- 暂缓(DEFER):赔率格式切换(美式/小数)、价格历史 sparkline(数据已在 cron 落库、未渲染)、只读钱包地址持仓/盈亏、提醒、PWA/原生、市场扫描器。需持久化/新表面或与无状态定位冲突。
- 明确不做(DON'T):任何"edge/+EV/beat-the-book"话术、隐藏相关腿做大赔付、赔率加成/连胜游戏化。与诚实定位冲突。

### 仍未做(唯一)
- 🔒 L2 非托管实盘执行 —— 法律门控(需律师签字 + 真实凭据),保持 fail-closed,不自动开放。

## 优先级次序

- **P0(现在)— 世界杯做最精确。** 把当前 live 版本的数值精度做到顶:用实时订单簿中点去 vig、本金假设透明化、来源/时效披露。详见本轮改动。
- **P1 — 部署世界杯版。** `vercel` + 设 `CRON_SECRET`(+可选 `DATABASE_URL` 起护城河、`AI_GATEWAY_API_KEY` 起 LLM 润色)。这是最快能拿到真实用户行为数据的一步。
- **P2 — 近触可填深度闸门(共享前置)。** 把 `notionalDepth`(整边求和,会被假墙骗)换成"走到 best ask+Nc 的可填美元"。**这是 P3 和 P4 的共同前置**,本身对世界杯薄盘也有保护价值。
- **P3 — 跨事件 reach-final NO(前6强,结构化蒙特卡洛)。** 价值=诚实覆盖,不是一堆新 GO。依赖 P2 深度闸门。
- **P4 — 跨域 A 政治滩头堡。** 去足球化(便宜)+ **硬化通用解析器(真正的活、头号风险)** + 每事件费率 + 静态嵌套表(`nominee⊂president`,不用 LLM)。**全年可用,解决赛后断崖。** F1/MLB 依赖 P2 深度闸门。
- **P5(以后,各自门控)— L2 非托管执行(需律师)、通用 LLM 跨事件分类器、加密/休赛期体育。**

## 依赖图(谁挡着谁)

```
P0 世界杯精度 ──> P1 部署
                    │
P2 近触深度闸门 ───┼──> P3 跨事件 reach-final
                    └──> P4 跨域(F1/MLB 那部分)
P4 去足球化 + 硬化解析器 ──> 政治滩头堡(不依赖 P2,Politics 本身够深)
静态嵌套表(P4)与 LLM 分类器(P5)互斥:先表后(也许永远不)LLM
方向 B(因果跨域)= 不做,除非接受假精度
```

## 一句话建议
P0(精度)→ P1(部署、拿数据)→ P2(深度闸门,小而关键)→ P4 政治(全年续命,价值最高)→ P3 跨事件(诚实覆盖)。L2 和 LLM 分类器都等明确信号再说。
