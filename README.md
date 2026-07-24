<div align="center">

# 🛩️ CarryPilot

### AI 资金费率套利 Agent · AI Funding-Rate Arbitrage Agent

**不预测涨跌，让 Agent 帮你收资金费率**
*Don't predict the market — let agents harvest funding.*

[![Live](https://img.shields.io/badge/Live-104.198.140.67%3A8080-2ee6a8?style=for-the-badge)](http://104.198.140.67:8080)
[![Chain](https://img.shields.io/badge/Hyperliquid-🌊-4d9fff?style=for-the-badge)](https://hyperliquid.xyz)
[![Injective](https://img.shields.io/badge/Injective-🥷-a78bfa?style=for-the-badge)](https://injective.com)
[![Hackathon](https://img.shields.io/badge/AdventureX-2026-ffb454?style=for-the-badge)](#)

**中文** · [English](#-english)

</div>

---

## 📖 一分钟看懂

> 永续合约要贴住现货价，靠的是多空双方每小时互付「资金费」。费率为正时，做多的人付钱给做空的人。
> **CarryPilot 同时买现货 + 做空等额永续**：币价涨跌两边抵消（市场中性），专门白收这笔小时费。
> AI Agent 负责找机会、算成本、开单、盯盘、见坏就撤 —— 你只需连钱包、创建 Agent。

```
        买入 $10,000 现货  ──┐                          ┌──  做空 $10,000 永续
         (币价涨→赚)         │      价格风险 ≈ 0        │      (币价涨→亏)
                            └────  涨跌互相抵消  ───────┘
                                        │
                                💰 每小时净收资金费（多头付给空头）
                                        │
                          ⚠ 扣掉：手续费 + 滑点 + 费率翻转风险
                             扣完还是正的，才叫机会 —— 引擎替你算
```

---

## 🗺️ 用户动线 · User Journey

```mermaid
flowchart LR
    A[🔗 连接钱包<br/>MetaMask/OKX/Rabby<br/>仅签名·不碰资金] --> B[📡 看清市场<br/>费率现状 + 套利机会<br/>扣完成本的真实净APR]
    B --> C[🤖 创建 Agent<br/>虚拟盘/实盘<br/>风格·资金·回合·AI偏好]
    C --> D[⚙️ 逐回合决策<br/>每10min: 拉费率→算成本<br/>→AI评估→风控→开/换/平仓]
    D --> E[📈 观测与复盘<br/>预测vs实际·风险预测<br/>平仓沉淀为记忆]
    E -.学习闭环.-> D
    style A fill:#10161f,stroke:#2ee6a8,color:#e9eef5
    style B fill:#10161f,stroke:#4d9fff,color:#e9eef5
    style C fill:#10161f,stroke:#a78bfa,color:#e9eef5
    style D fill:#10161f,stroke:#ffb454,color:#e9eef5
    style E fill:#10161f,stroke:#2ee6a8,color:#e9eef5
```

---

## 🏗️ 系统架构 · Architecture

```mermaid
flowchart TD
    subgraph L1[数据层 Data]
        HL[🌊 Hyperliquid API<br/>费率/盘口/现货 · 10min]
    end
    subgraph L2[智能层 Intelligence]
        ENG[⚙️ 确定性引擎<br/>成本瀑布·净APR·拒绝码]
        LLM[🐋 AI 评估<br/>可持续性判断·带复盘记忆<br/>只建议·不改数值]
        RISK[🛡️ RiskGuard<br/>仓位/资金硬顶·LLM不可越权]
    end
    subgraph L3[执行层 Execution]
        VIRT[🧪 虚拟盘<br/>零风险记账]
        LIVE[⚡ 实盘<br/>双腿下单·失败回滚]
    end
    subgraph L4[Injective]
        PTS[🥷 INJ 积分<br/>Agent 燃料·链上充值]
        RCP[📜 Receipt<br/>防篡改哈希]
    end
    HL --> ENG --> LLM --> RISK --> VIRT & LIVE
    VIRT & LIVE --> RCP
    PTS -.燃料.-> ENG
    VIRT & LIVE -.观测回流.-> OBS[📊 五大中心<br/>费率·机会·Agent·收益·风险]
    style L1 fill:#0a0e14,stroke:#4d9fff
    style L2 fill:#0a0e14,stroke:#2ee6a8
    style L3 fill:#0a0e14,stroke:#ffb454
    style L4 fill:#0a0e14,stroke:#a78bfa
```

**核心设计原则**：AI 只负责判断与解释，所有数值与下单由确定性代码完成。LLM 输出永远只是「建议」，仓位/限额/止损由 RiskGuard 强制执行。

---

## 📦 版本说明 · Versions

### 🎯 产品版本 · Product

| 中心 | 能力 |
|---|---|
| 📡 **费率现状** | 全市场实时资金费率、年化、7 天坐标曲线、标签（多付费/空付费/费率偏高/波动大）、一键跳转 HL |
| 🔬 **套利机会** | 确定性引擎扣完成本的真实净 APR、机会置顶高亮、对冲结构、成本瀑布图、大白话收益表（投入 1k~20k 每 8h/天/周）、术语问号即点即懂 |
| 🤖 **Agent 中心** | 虚拟盘/实盘切换、燃料余量置顶、全局统计（胜率/回合/PnL）、决策日志、预测 vs 实际对比图、复盘记忆 |
| 📈 **收益中心** | PnL 曲线、平仓记录、防篡改 Receipt 哈希 |
| 🛡️ **风险中心** | 逐仓风险分级、费率衰减告警、48h 三情景 PnL 预测图、实盘清算价观测 |
| ⚙️ **设置** | 钱包信息、虚拟盘资金设置、INJ 积分充值、实盘交易授权 |

### 💼 业务版本 · Business

- **市场中性套利**：HL 站内「现货多 + 永续空」，对冲价格风险，收资金费
- **虚拟盘 / 实盘双轨**：虚拟盘零风险体验（自设资金），实盘经无提币权限的 API Wallet 真实下单，账户/收益/风险体系完全隔离
- **Agent 自主运营**：每 10 分钟一回合，AI 评估 + 确定性风控，自动开仓/换仓（含磨损核算）/清仓，回合制生命周期（内测上限 120）
- **积分燃料经济**：INJ 充值 → 积分 → Agent 每回合消耗，链上 txhash 幂等入账
- **学习闭环**：每笔平仓自动复盘沉淀为记忆，喂给后续 AI 决策

### 🔧 技术版本 · Technical

```
Node.js 22 + TypeScript (strict)  ·  零重框架、单进程 orchestrator
├─ src/connectors/   HL Info/Exchange API · Injective LCD · HL 实盘 SDK
├─ src/core/         candidates(引擎) · agents(回合决策) · risk · llm · points · store
├─ src/web/          零依赖 HTTP server + 单文件前端（明暗主题/中英文/移动端）
└─ scripts/          acceptance.ts 端到端验收（22 用例）
```

- **LLM**：OpenRouter 网关（对外仅显示模型家族名），带风控 system prompt + 复盘记忆上下文
- **钱包**：EIP-6963 多钱包发现 + 移动端深链跳转；EIP-712 签名登录 + ApproveAgent 授权
- **部署**：GCP VM + systemd，公网 mainnet；Telegram 桥可远程遥控开发

---

## 🚀 快速开始 · Quickstart

```bash
git clone https://github.com/OneHaydenZhang/CarryPilot.git && cd CarryPilot
bash scripts/setup.sh                 # 装依赖 + 构建 Injective MCP
cp .env.example .env                  # 填 OPENROUTER_API_KEY（可选）等
npm run web                           # 启动，默认 http://localhost:8080
BASE_URL=http://localhost:8080 npx tsx scripts/acceptance.ts   # 22 项验收
```

**在线体验**：👉 **http://104.198.140.67:8080** （连接钱包即可创建虚拟盘 Agent）

---

## 🧠 套利为什么存在？

| | |
|---|---|
| ⚓ **永续需要锚** | 永续无交割日，靠资金费率把合约价拉回现货价，费用每小时结算 |
| 🐂 **多头天然拥挤** | 牛市人人加杠杆做多 → 费率长期为正 → 空头持续收钱 |
| 🛡️ **对冲近乎无风险** | 现货多+永续空让涨跌抵消，只剩费率收入，剩余成本可被引擎精确计算 |

**这不是漏洞，是机制性的钱** —— 会持续流向愿意站在少数派（空头）一边平衡市场的人。

---

<div align="center">

## 🌐 English

</div>

**CarryPilot** is an AI funding-rate arbitrage agent on Hyperliquid. It runs market-neutral carry: **long spot + short an equal perp**, so price moves cancel out and you collect the hourly funding that longs pay shorts. AI agents find opportunities, compute true costs, open positions, monitor, and exit — you just connect a wallet and create an agent.

**Why arbitrage exists**: perpetuals need an anchor (funding pulls contract price to spot), longs are structurally crowded (funding stays positive → shorts get paid), and hedging makes it near risk-free (spot+perp cancel directional risk, leaving only fees/slippage the engine computes precisely).

**Five centers + settings**: Rates (live funding + 7-day charts + tags), Opportunities (net APR after full costs, cost-waterfall, plain payout tables), Agent (virtual/live workspaces, decision logs, predicted-vs-actual charts, review memory), Earnings (PnL curve + receipt hashes), Risk (per-position levels + 48h scenario projections), Settings (virtual balance, INJ credit top-up, live trading authorization).

**Key principle**: AI only judges and explains; all numbers and orders come from deterministic code. LLM output is always *advice* — position/limit/stop are enforced by RiskGuard.

**Tech**: Node 22 + TypeScript, zero heavy frameworks, single-process orchestrator. LLM via OpenRouter (model family name only shown). Multi-wallet (EIP-6963) + mobile deep-links. Deployed on GCP mainnet.

Try it live 👉 **http://104.198.140.67:8080**

---

<div align="center">

⚠️ *研究与模拟用途，不构成投资建议或收益承诺。示例数字为机制说明的假设，实际费率随市场波动。实盘请仅使用可承受损失的资金。*
*For research/simulation. Not investment advice. Live trading uses only funds you can afford to lose.*

**🛩️ CarryPilot** · Hyperliquid × Injective · AdventureX 2026

</div>
