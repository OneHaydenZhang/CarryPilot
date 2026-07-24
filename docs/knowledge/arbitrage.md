# 套利基础知识与 Hyperliquid 套利模式分析

> 本项目的策略层知识基线。数据接口细节见 `hyperliquid.md` / `injective.md`。最后核对时间：2026-07-25

## 1. 套利分类学（taxonomy）

| 模式 | 原理 | 收益来源 | 主要风险 | 频率/延迟要求 |
|---|---|---|---|---|
| **资金费率套利**（funding carry） | 永续合约多空双方定期互付资金费；做 delta 中性组合收费率 | funding 支付 | 费率翻转、腿失衡、清算 | 低频（小时级），**延迟不敏感** |
| **现货-永续基差**（cash & carry） | 同标的现货与永续价差（基差）回归 | 基差收敛 + funding | 基差扩大、现货流动性 | 低中频 |
| **跨所价差**（cross-venue） | 同标的在两所的瞬时价差 | 价差 - 双边费用 | 执行延迟、单腿成交 | 高频，延迟敏感 |
| 跨所资金费率差 | 两所同标的 perp 费率不同，两边反向开仓 | 费率差 | 两所保证金管理、结算周期不同步 | 低频 |
| 三角/路径套利 | 同所内 A→B→C→A 价格环 | 定价不一致 | 极高竞争、MEV | 极高频 |
| 统计套利 | 相关资产价差均值回归 | 统计规律 | 模型风险（非无风险套利） | 中频 |

**关键认知：本项目（AI agent 驱动、HL+INJ 双所、非 colocation）的比较优势在低中频模式** —— 资金费率类、基差类。纯延迟竞赛型（跨所高频价差、三角）拼的是基础设施，不是 AI，做市商已把利润压到微米级，不作为主线。

## 2. Hyperliquid 资金费率机制（官方文档核实）

- **公式**：`F = Average Premium Index + clamp(interest_rate - P, -0.05%, +0.05%)`
  - `premium = impact_price_difference / oracle_price`（impact bid/ask 相对 oracle 的偏离）
  - `interest_rate` 固定 = 0.01% / 8h
  - premium 每 **5 秒采样**，按小时平均
- **结算**：**每小时支付一次**，每次支付 8 小时费率的 1/8；支付额 = `position_size × oracle_price × funding_rate`（用 **spot oracle 价**，不是 mark price）
- oracle 价 = 各大 CEX 现货价的加权中位数
- 上限 4%/hour；funding 为正 → 多头付空头；为负 → 空头付多头

### 数据获取（全部免签名、免 key）
| 数据 | 接口 | 说明 |
|---|---|---|
| 当前费率 + 标记价 + OI | `POST /info` `{"type":"metaAndAssetCtxs"}` | 返回每个 perp 的 `funding`（当前小时费率）、`markPx`、`oraclePx`、`openInterest`、`premium` |
| **多所预测费率** | `{"type":"predictedFundings"}` | **官方直接给出 HL/Binance/Bybit 等各所下一期费率** —— 跨所费率差策略的现成数据源 |
| 历史费率 | `{"type":"fundingHistory","coin":"BTC","startTime":...}` | 回测/统计用 |
| 实时推送 | WS `activeAssetCtx` 订阅 | 盯盘用 |
| 现货盘口 | `l2Book`（coin 用 `"@{index}"` 或 `"PURR/USDC"`） | 现货腿执行 |

## 3. 基于 HL 的可行策略模式（按实施优先级）

### 模式 A：HL 站内「现货多 + 永续空」资金费率捕获（v0 首选）
> 即用户说的「开多开空赚资金费率」的规范形态。注：**HL 没有期权产品**（只有 perp + spot），"期权和现货"应理解为"永续和现货"。

- 结构：买入现货 X 数量 + 做空等值 perp → **delta 中性**（价格涨跌不影响净值），每小时收正 funding
- 前提：`funding > 0` 且预期持续；HL 现货标的有限（HYPE、PURR 等 USDC 对），**策略容量受现货流动性约束**
- **盈亏平衡数学**（进出各一次）：
  - 成本 ≈ 4 × taker fee（两腿开+两腿平）+ 2 × spread/2 ≈ 0.045%×4 + spread ≈ **0.2%~0.3%**
  - 若年化 funding = 15%（≈0.0017%/h），回本需 ~5-7 天持仓 → **这是持有型策略，不是进出型**
  - 用 maker（`Alo` 挂单）可把费用砍半以上，但有不成交腿风险
- 风险控制：空头腿保证金缓冲（清算价监控）、funding 翻负的退出阈值、两腿数量对齐（`szDecimals` 取整后残差）

### 模式 B：跨所资金费率差（HL ↔ Binance/Bybit 或 HL ↔ Injective）
- `predictedFundings` 直接给出各所费率 → 在费率高的所做空、低的所做多，两腿都是 perp，delta 中性
- 相比模式 A：不受 HL 现货容量限制、可做 BTC/ETH 等大市值；代价是**两所保证金管理 + 资金划转慢**（跨所再平衡要走桥/提现）
- HL ↔ INJ 版本：INJ 侧费率从 Indexer `derivative markets` 的 `perpetualMarketFunding` 读取；INJ maker 有返佣，适合当 maker 腿

### 模式 C：HL ↔ INJ 跨所价差（谨慎，二期再评估）
- 两边都是链上订单簿，同标的（BTC/ETH perp）盘口价差偶发拉开
- INJ 出块 ~650ms + FBA 批量撮合 → **单腿延迟下限被锁死**，只能吃「大且持续数秒以上」的价差；需要实测价差分布后再决定投入

### 模式 D（AI 增值层，贯穿 A/B/C）
LLM agent 不负责发现微观价差（规则代码更快更稳），而负责：
1. **机会评估**：给定 funding 历史 + OI + 盘口深度，判断费率可持续性（比纯阈值规则强）
2. **参数治理**：动态调整仓位上限、进出阈值、标的白名单
3. **异常解释与复盘**：把每笔决策写成结构化理由（落库），事后审计

## 4. 生产级执行要点（所有模式通用）

- **双腿原子性没有保证** → 执行顺序：先难成交的腿（流动性差的一侧），成交后立即对冲另一腿；单腿超时 → 立即市价平掉已成交腿（damage control 优先于利润）
- 仓位状态以**交易所回报为准**（`clearinghouseState` 定期 reconcile），本地台账只是缓存
- funding 结算在整点，进出场时机对齐结算边界可多收/少付一期
- 费用感知：`userFees` 实时读自己档位费率，机会计算必须扣费后为正
- 容量控制：单标的仓位 ≤ 盘口深度的安全比例（如 top5 档 10%），避免自己吃掉价差
