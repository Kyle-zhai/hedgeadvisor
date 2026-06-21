# 要做成 mockup 那样的 dashboard,还缺哪些"真实功能"

> 本轮已经把**界面**做成了 mockup 的样子,而且每个数字都来自真实 live 数据。
> 下面是"长得像 ≠ 功能齐全"的真实差距清单,按依赖分组。

## ✅ 已经是真的(本轮完成,真实数据驱动)
- 左侧栏 + 顶部 tab + "Priced from live CLOB" 徽标。
- Build plan 仪表盘:Market/Bet typeahead(真实市场)、Budget、Number of bets 步进器、Express↔Protect 滑块。
- 统计行:Deployed / Chance of profit / Expected value / Best / Worst / **Max loss protected(vs 全押)** / **Verdict(诚实判定)**。
- Payoff scenarios(概率条)、Risk change(前后对比条)、Plan construction(Fair/You pay/Gap/Shares/Limit/Est cost + 每行 Copy/Open)、**Cost breakdown 堆叠条(fair/spread/slippage/fee/vig,精确加总到 deployed)**、Alternatives ranked、Market data & safety(快照时间/overround/费率)。

## ❌ 仍缺的真实功能(要补的"后端/能力",不是样式)

### A. 需要"持久化 + 身份"(目前完全无状态)
1. **Plan history / History 页**:保存历史方案、回看"当时诚实判定 vs 真实结果"。需要存储 + 一个身份。现在是诚实占位页。
2. **Settings / 偏好**:赔率格式(美式/小数)、默认 bankroll、收藏市场、提醒阈值。需要存储。占位中。
3. **持仓导入 / 组合 P&L**:Hedge 页现在要你**手输**持仓+本金。真实做法是粘贴**公开钱包地址**只读拉取你在 Polymarket 的真实持仓+成本(无托管、无登录)。未做。
4. **价格提醒**:"对冲变划算时通知我"。需要存储 + 通知通道。未做。

### B. 需要"执行/法务"
5. **一键下单(L2)**:mockup 自己也写了 "Manual placement only / We do not place orders"——所以现在的"Copy + Open 深链 + 限价"就是诚实的全部。真正的应用内下单(非托管签名)被**法务门控**(`HEDGE_L2_ENABLED` 不开),需律师签字 + 真实凭据才上线。L3 托管永不做。

### C. 需要"实时流"
6. **真·实时刷新**:现在 "Live" 是**每次请求**去拉 live CLOB(防抖重定价),不是 websocket 持续推送。要做成盘口一动数字就跳,需要订阅 CLOB 行情流 + 自动刷新。
7. **价格历史小图(sparkline)**:cron 其实已经在往 DB 落快照,但没有读取/渲染。补一个读接口 + 内联图即可。

### D. 需要"引擎覆盖更多"
8. **Markets 浏览/扫描页**:按成交量/类别列出 live 市场、并标出"现在存在便宜诚实对冲"的市场。需要列表接口 + 排序(+ 收藏要持久化)。现为占位。
9. **更多投注类型**:现支持 胜平负 / 精确比分 / 大小球 / BTTS。**亚盘让分、球员 prop** 还没解析。
10. **跨场 parlay(Polymarket Combos)**:现在是单赛事方案;多腿连过是另一种方案类型,未做。
11. **更丰富的 Alternatives**:现在是 "Don't bet / All-in / 本方案" 三行。可自动评估多档 posture×注数 并排名(易扩展)。

## ⚠️ 一个诚实取舍(不是 bug)
- mockup 的 **"Risk removed per $1 spent 3.1x"** 我**没**照搬到 Plan 页,而是换成了 **"Max loss protected 68% / 波动率下降 %"**。原因:对一个"主动构建的方向性下注",把成本都算成"买风险下降"在数学上站不住(那笔成本主要买的是**敞口**,不是风险下降)。这个 per-$ 效率比 η 在 **Hedge 页**是良定义的(那里有明确的"持仓"和"对冲成本"),已经在用;Plan 页用百分比下降更诚实。

## 一句话
界面已 100% 是 dashboard 的样子且数字真实;要补的真实功能集中在**持久化(history/settings/portfolio/alerts)、实时流、一键执行(法务门控)、Markets 扫描页、更多投注类型**。其中"持久化 + 只读钱包持仓"是解锁最多格子(History/Portfolio/Settings)的那块基石。
