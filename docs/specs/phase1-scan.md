# Phase 1（v0.1）：成本后机会扫描的最小闭环

> 从 PRD v2 拆出的第一期。目标：**用户动线跑通且清晰**，不求功能全。

## 第一期用户动线（唯一主线）

打开网页 → 看到 BTC/ETH/SOL 的实时「成本后候选」列表（ACCEPTED 绿 / REJECTED 灰，均展示）→ 点击任一候选 → 看到两条腿、成本瀑布、净 APR 与拒绝码 → 理解「毛 APR ≠ 净收益」这一产品核心主张。

## 范围

**做**：
- S1（HL 现货 UBTC/UETH/USOL + HL 永续空腿，wrapper_risk 标记）
- S2（HL ↔ Injective / Binance / Bybit 永续费率差；Binance/Bybit 费率来自 HL 官方 predictedFundings 聚合）
- 确定性成本引擎：双腿开平仓费、滑点准备金、不确定性准备金；Gross / Modeled Net 分口径
- 风控硬门：REJECTED_COST / REJECTED_MAPPING / REJECTED_LIQUIDITY / REJECTED_UNSUPPORTED / REJECTED_STALE_DATA
- Web（Scan + Candidate 两屏合一）+ `/api/scan` + `/api/health`；60s 缓存；固定风险提示

**不做（后续期）**：A2A server、回测、paper 状态机、LLM 解释层、ERC-8004/x402/Receipt、Postgres（当前无持久化）

## 验收
- AC-01（成本拒绝展示成本归因）、AC-09（Injective 数据进入比较）、AC-13（固定风险提示）在页面可见
- 部署于 GCP VM systemd，公网可访问
