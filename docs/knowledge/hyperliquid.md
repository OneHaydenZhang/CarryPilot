# Hyperliquid 技术体系与接入方法

> 本文档是本仓库的 Hyperliquid 权威知识沉淀，供 AI 助手与开发者在真实需求开发时直接引用。
> 来源：官方文档 https://hyperliquid.gitbook.io/hyperliquid-docs（完整索引见 `/llms.txt`，任意页面 URL 追加 `.md` 可得 Markdown 版）。
> 最后核对时间：2026-07-25

## 1. 架构总览

Hyperliquid 是一条为金融应用优化的 L1，由三部分组成：

| 组件 | 说明 |
|---|---|
| **L1 / HyperBFT** | 自研共识算法，one-block finality |
| **HyperCore** | 完全链上的永续合约 + 现货订单簿，约 200k orders/s |
| **HyperEVM** | 通用 EVM 智能合约层，与 HyperCore 流动性原语互通 |

对套利平台而言：**HyperCore 是交易执行层**（通过 REST/WS API 交互，不需要合约），HyperEVM 仅在需要链上合约逻辑时使用。

## 2. API 端点

| 用途 | Mainnet | Testnet |
|---|---|---|
| Info（行情/账户查询） | `https://api.hyperliquid.xyz/info` | `https://api.hyperliquid-testnet.xyz/info` |
| Exchange（下单/撤单） | `https://api.hyperliquid.xyz/exchange` | `https://api.hyperliquid-testnet.xyz/exchange` |
| WebSocket | `wss://api.hyperliquid.xyz/ws` | `wss://api.hyperliquid-testnet.xyz/ws` |

全部为 `POST` + `Content-Type: application/json`。

## 3. Info Endpoint（查询，无需签名）

请求体形如 `{"type": "<requestType>", ...params}`。套利平台最常用：

### 行情类
- `allMids` — 所有币种 mid price（可选 `dex` 参数指定 HIP-3 DEX）
- `l2Book` — L2 订单簿快照，参数 `coin`（必填）、`nSigFigs`、`mantissa`；每边最多 20 档（price/size/count）
- `candleSnapshot` — OHLCV，参数 `coin`/`interval`/`startTime`/`endTime`；interval 支持 1m~1M，最多返回 5000 根
- `metaAndAssetCtxs` / `meta` — 永续 universe 元数据 + 资金费率、标记价、未平仓量等上下文（**资金费套利核心数据源**）
- `fundingHistory` / `predictedFundings` — 历史/预测资金费率

### 账户类（`user` 必须是主账户/子账户地址，**不能是 agent 钱包地址**）
- `clearinghouseState`（perp 仓位、保证金）、`spotClearinghouseState`（现货余额）
- `openOrders` / `frontendOpenOrders` / `historicalOrders` / `orderStatus`
- `userFills` / `userFillsByTime`（最多 2000 条/次，只保留最近 10000 条，用最后一条 timestamp 分页）
- `userFees`（费率档位）、`userRateLimit`（API 限额状态）、`portfolio`（PnL 历史）
- `subAccounts` / `userRole` / `vaultDetails` / `userVaultEquities`

### 资产标识约定
- **Perp**：asset id = universe index；Info 请求里 coin 用名字（如 `"BTC"`）
- **Spot**：asset id = `10000 + spot index`；coin 名用 `"PURR/USDC"` 或 `"@{index}"`（如 `@107` = HYPE）
- **HIP-3 DEX 资产**：前缀 dex 名，如 `"xyz:XYZ100"`

## 4. Exchange Endpoint（交易，需签名）

请求体：`{"action": {...}, "nonce": <ms timestamp>, "signature": {...}, "vaultAddress"?: "0x..", "expiresAfter"?: <ms>}`

### 关键 action 类型
- `order` — 下单。字段缩写：`a`=asset, `b`=isBuy, `p`=price(string), `s`=size(string), `r`=reduceOnly, `t`=type, `c`=cloid(可选 16 字节 hex)
  - Limit: `"t": {"limit": {"tif": "Gtc"|"Ioc"|"Alo"}}`（Alo = post-only）
  - Trigger: `"t": {"trigger": {"isMarket": true, "triggerPx": "50000", "tpsl": "tp"|"sl"}}`
  - `grouping`: `"na"` 普通，`"normalTpsl"`/`"positionTpsl"` 用于 TP/SL 组合单
- `cancel`（按 oid）/ `cancelByCloid` / `batchModify` / `modify`
- `scheduleCancel` — dead man's switch（最少 5s 延迟），**做市/套利 bot 必备**
- `updateLeverage` / `updateIsolatedMargin`
- `twapOrder`（`m`=分钟, `t`=randomize）
- `usdSend`（Core USDC 转账）、`sendAsset`（跨 perp/spot/子账户划转）
- `approveAgent` — 授权 API wallet
- `noop` — 作废 pending nonce
- 成功响应：`{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":...}} | {"filled":{"totalSz","avgPx","oid"}} | {"error":"..."}]}}}`

### 价格与数量精度（tick/lot）
- 价格：最多 5 位有效数字，且小数位 ≤ `MAX_DECIMALS - szDecimals`（perp MAX_DECIMALS=6，spot=8）
- 数量：按该资产 `szDecimals` 取整
- 字符串不要有尾随零（trailing zeros 会导致签名/校验问题）

## 5. 签名（最容易踩坑的部分）

- **两套签名方案**：
  1. `sign_l1_action`（下单/撤单等交易类）：action 经 **msgpack 序列化 → keccak hash →（伪造 "phantom agent" 结构）→ EIP-712 签名**；msgpack **字段顺序敏感**
  2. `sign_user_signed_action`（usdSend、withdraw、approveAgent 等）：直接 EIP-712 typed data，带 `signatureChainId`（如 `0xa4b1`）与 `hyperliquidChain: "Mainnet"|"Testnet"`
- 常见错误：字段顺序不对、地址未 lowercase、数字尾随零。签名错误**不会报错**，只会 recover 出另一个地址导致 "does not exist" 类错误
- **强烈建议直接用官方 SDK 的签名实现，不要手写**。核对基准 = Python SDK 实现

### Nonce 规则
- 有效窗口 `(T - 2 days, T + 1 day)`；每地址保存 **最高的 100 个 nonce**，新 nonce 必须 > 集合中最小值且未用过
- nonce 按**签名者**（signer）计，API wallet 各自独立 nonce 集
- 最佳实践：每个交易进程一个 API wallet + 原子计数器生成 nonce（`max(last+1, now_ms)`）

### API Wallet（Agent Wallet）
- 主账户通过 `approveAgent` 授权，可代表主账户/子账户**签名交易**，但**查询时仍要传主账户地址**
- 在 https://app.hyperliquid.xyz/API 页面可生成
- 被注销/过期/主账户清零资金时会被 prune，**nonce 状态可能被清 → 重放风险**，不要复用旧 agent 地址
- 多子账户策略：每个子账户单独 API wallet，避免 nonce 冲突

## 6. WebSocket

- 订阅：`{"method": "subscribe", "subscription": {"type": "<channel>", ...}}`
- 常用 channel：`allMids`, `l2Book`, `trades`, `bbo`, `candle`, `orderUpdates`, `userFills`, `userEvents`, `activeAssetCtx`（含资金费）, `webData2`
- 支持通过 WS 发 `post` 请求（info/exchange 均可），降低延迟
- 心跳：连接 60s 无消息会被断开，需发 `{"method": "ping"}`（服务端回 `pong`）
- **必须实现自动重连**，重连后重新订阅（snapshot 会补数据）

## 7. 限频（设计交易系统前必读）

### IP 维度（1200 weight/分钟）
- exchange 请求 weight = `1 + floor(batch_length / 40)`
- info：`l2Book`/`allMids`/`clearinghouseState`/`orderStatus` = 2；大多数 = 20；`userRole` = 60；部分按返回条数加权
- WS：最多 10 连接、1000 订阅、2000 消息/分钟、100 inflight post

### 地址维度
- 累计交易量 1 USDC = 1 次请求额度，初始 buffer 10,000 次；耗尽后每 10s 放行 1 次
- cancel 额度更高：`min(limit + 100000, limit * 2)`
- 批量请求按 IP 算 1 次、按地址算 n 次
- 未成交挂单上限：基础 1000 单，每 5M USDC 交易量 +1，上限 5000

## 8. SDK 选型

| SDK | 包名 | 说明 |
|---|---|---|
| **Python（官方）** | `hyperliquid-python-sdk` | `Info` / `Exchange` 两个主类，签名实现的参考基准 |
| **TypeScript（社区，最完善）** | `@nktkas/hyperliquid` | 类型完整、支持 WS，社区事实标准 |
| Rust（官方） | `hyperliquid_rust_sdk` | 低延迟场景 |

Python 快速上手：
```python
from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants
info = Info(constants.MAINNET_API_URL, skip_ws=True)
mids = info.all_mids()
# 交易：Exchange(wallet, constants.MAINNET_API_URL, account_address=主账户地址)
# wallet 用 API wallet 的私钥（eth_account.Account）
```

## 9. HyperEVM（需要链上合约时）

- Mainnet chain id **999**，RPC `https://rpc.hyperliquid.xyz/evm`；Testnet chain id **998**，`https://rpc.hyperliquid-testnet.xyz/evm`
- gas token = HYPE；双块架构（小块 ~1s / 大块 ~1min，大块给高 gas 上限部署用）
- 通过**预编译合约**（precompiles, 地址 `0x0800` 起）读 HyperCore 状态（仓位、oracle 价、L1 block number 等）；通过 `CoreWriter`（`0x333...3333`）从 EVM 向 HyperCore 发交易动作
- HyperCore ↔ HyperEVM 资产互转通过系统地址（如 spot 资产对应 `0x2000...` + token index）

## 10. 套利场景要点备忘

- **资金费率套利**（HL perp vs 其他所/现货）：用 `metaAndAssetCtxs` 读 `funding`（每小时结算，8h 费率的 1/8 每小时计）、`predictedFundings` 对比多所
- **跨所价差**：WS `bbo`/`l2Book` 低延迟盘口；下单用 `Ioc` + reduceOnly 管理腿风险
- 手续费从 `userFees` 读取（默认 taker ~0.045% / maker ~0.015%，随量阶梯，需实时查）
- 入金：USDC 经 Arbitrum Bridge2（官方桥），账户激活有小额 gas 费
- 生产 bot 清单：API wallet 隔离、`scheduleCancel` 兜底、WS 重连、nonce 原子化、限频预算、双腿失败回滚
