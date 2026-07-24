# Phase 2（v0.2）：钱包身份 + 用户可操作的 Carry Agent（paper-only）

> 用户反馈驱动：要有钱包登录、清晰用户动线（参考 manekiai.io）、用户能实际操作。PRD 约束不变：paper-only，钱包仅做身份，不托管任何资金。

## 用户动线（对齐 Maneki 模式）

1. **Landing**：价值主张 + Launch App
2. **Connect Wallet**：MetaMask 签名登录（无交易、无 gas、不触碰资金）；引导切到 Injective EVM (1776)
3. **创建 Agent**：选资产（BTC/ETH/SOL/全部）、风格（保守/均衡/激进 → 决定入场净APR门槛与仓位比例）、模拟资金。**策略固定为 HL 站内 S1（现货多+永续空）——用户明确要求第一版不做跨所**；universe 扩展到 HL 上同时有现货和永续的全部币种（核心三币始终展示）
4. **Agent 自主运行**：每 60s 扫描 → 候选过风控硬门且达到风格门槛 → 自动开模拟仓；净值恶化/费率翻转 → 自动平仓；每个 tick 写决策日志（为什么开/为什么不开）
5. **Terminal**：实时持仓 PnL、决策日志、历史仓位与 Receipt 哈希；可手动平仓/停止 Agent

## 机制设计

- **身份**：nonce + personal_sign，viem 验签，HMAC session token（data/secret 持久化）
- **状态**：`data/store.json` 原子写（tmp+rename）；agents / positions / decision logs（每 agent 环形 50 条）
- **引擎**：web 进程内 60s tick（复用扫描缓存）：
  - running agent 无持仓 → 从 ACCEPTED 候选中挑净APR最高且匹配配置的开仓（notional = capital × 风格系数，上限封顶）
  - 有持仓 → 按 dt 累计 funding PnL；候选恶化（netApr < 退出阈值 或变 REJECTED）→ 自动平仓 `FUNDING_DETERIORATED`
  - 每 agent 同时最多 1 仓（v0.2）
- **Receipt**：平仓记录 sha256 → receiptHash（链上锚定属后续期 INJ-05）
- **风控硬编码**：模拟资金 ≤ $100k、名义仓位封顶、LLM 不在此循环（确定性规则）

## 不做（后续期）
A2A、回测、真实下单、ERC-8004/x402/链上 Receipt、多仓位组合、Postgres
