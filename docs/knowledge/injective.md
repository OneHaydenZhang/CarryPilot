# Injective 技术体系与接入方法

> 本文档是本仓库的 Injective 权威知识沉淀，供 AI 助手与开发者在真实需求开发时直接引用。
> 来源：官方文档 https://docs.injective.network/（完整索引见 `/llms.txt`）；AdventureX 2026 黑客松指南推荐官方 SDK / EVM / CosmWasm。
> 最后核对时间：2026-07-25

## 1. 架构总览

Injective 是 Cosmos SDK 系 L1，特点：

- **链上订单簿交易所模块**（exchange module）：现货 + 永续/交割衍生品是**链的原生模块**，不是合约
- **MEV 防护**：Frequent Batch Auction (FBA) 交易排序
- **MultiVM**：同时支持 **EVM**（原生嵌入，非 rollup）与 **CosmWasm**（Rust 合约），共享资产与状态
- **性能**：~25,000 tx/s、650ms 出块、近即时最终性、tx 费 < $0.01
- **互操作**：IBC（110+ 链）、Ethereum（Peggy 桥）、Solana/Wormhole
- gas token = **INJ**

对本项目：**exchange module（衍生品/现货订单簿）+ oracle module + EVM** 是核心；AI 侧走官方 ainj 工具链。

## 2. 网络信息（EVM）

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | **1776** | 1439 |
| JSON-RPC | `https://sentry.evm-rpc.injective.network/` | `https://k8s.testnet.json-rpc.injective.network/` |
| Archival RPC | `https://evm.archival.chain.virtual.json-rpc.injective.network/` | `https://testnet.evm.archival.chain.virtual.json-rpc.injective.network/` |
| WebSocket | `wss://sentry.evm-ws.injective.network` | `wss://k8s.testnet.ws.injective.network/` |
| Explorer | `blockscout.injective.network` | `testnet.blockscout.injective.network` |
| Explorer API | `https://blockscout-api.injective.network/api` | `https://testnet.blockscout-api.injective.network/api` |
| wINJ | `0x0000000088827d2d103ee2d9A6b781773AE03FfB` | 同左 |
| USDT | `0x88f7F2b685F9692caf8c478f5BADF09eE9B1Cc13` | `0xaDC7bcB5d8fe053Ef19b4E0C861c262Af6e0db60` |
| wETH | `0x83A15000b753AC0EeE06D2Cb41a69e76D0D5c7F7` (MTS) | — |

Cosmos 侧公共端点（mainnet）：LCD/REST `https://sentry.lcd.injective.network`（swagger 可查），Indexer API `https://api.injective.network`。Testnet faucet：`testnet.faucet.injective.network`（另有 Google Cloud / Circle faucet）。

## 3. EVM 开发

- 标准 EVM 工具链全兼容：**Hardhat / Foundry** 编译、测试、部署、verify（Blockscout）
- 部署与任何 EVM 链无异：配置 RPC + chainId 1776/1439 即可
- **Precompiles（Injective 特色，EVM 直达原生模块）**：
  - `bank precompile` — 原生 bank 余额/转账
  - `exchange precompile` — **从 Solidity 直接调用链上订单簿**（下单、撤单、查仓位、子账户划转）→ 套利合约的关键能力
  - `oracle precompile` — 读原生 oracle 价格
- **MultiVM Token Standard (MTS)**：token 在 EVM(ERC20) 与 Cosmos bank 间统一余额，无需桥；`erc20-module` 管理映射；wINJ 处理 INJ↔wrapped
- 钱包接入：MetaMask / WalletConnect 直接支持（standard EVM dApp 方式）

## 4. CosmWasm 开发

- Rust + `cw-injective`（`injective-cosmwasm`, `injective-math` 等 crates），可在合约内访问 exchange module（读订单簿、下单）
- 本地开发 `injective-test-tube`；主网部署需通过治理或白名单地址（见 `mainnet-deployment-guide` / `whitelisting-deployment-address-guide`）
- 对快速迭代的黑客松项目：**优先 EVM + precompiles**，CosmWasm 仅在需要深度定制时用

## 5. Exchange Module（链上订单簿）

- 市场类型：spot、perpetual、expiry futures、pre-launch futures、index perp、iAssets、24/5 equity feeds（美股类）
- 订单类型：limit / market / stop-loss / take-profit，post-only 等
- 保证金/清算/资金费率均为原生模块逻辑（`margin-funding-rates`、`margin-liquidation`）
- 交易账户模型：**subaccount**（地址 + 32 字节 subaccount id），资金从 bank 存入 subaccount 后交易
- 手续费有 maker rebate 机制（见 `defi/trading/fees`）
- 查询三条路径：
  1. **Chain gRPC/LCD**（链上实时状态）
  2. **Indexer API**（历史 + 聚合，`api.injective.network`）
  3. **Indexer Stream**（gRPC stream 实时推送）

## 6. SDK 选型

| SDK | 入口 | 说明 |
|---|---|---|
| **TypeScript** | `@injectivelabs/sdk-ts`（injective-ts monorepo） | 主力。querying、tx 构造/签名/广播、wallet 抽象（`@injectivelabs/wallet-ts`）、`@injectivelabs/networks` 提供端点常量 |
| Python | `injective-py`（InjectiveLabs/sdk-python） | 量化脚本友好，Async API |
| Go | `InjectiveLabs/sdk-go` | 节点级/高性能服务 |
| Rust | `cw-injective` / `injective-rust` | CosmWasm 合约 |

TS 常用模式（`@injectivelabs/sdk-ts`）：
- Query：`IndexerGrpcDerivativesApi` / `IndexerGrpcSpotApi`（市场、订单簿、成交）、`ChainGrpcBankApi`（余额）、`IndexerGrpcOracleApi`
- Tx：`MsgCreateDerivativeLimitOrder` / `MsgCreateSpotMarketOrder` 等 Msg 类 + `MsgBroadcasterWithPk` 广播
- 端点：`getNetworkEndpoints(Network.Mainnet)` / `Network.Testnet`

## 7. AI 开发工具（ainj / agent skills / MCP）— 本机已就绪

### 已完成的安装（2026-07-25）
```bash
npm install -g @injectivelabs/ainj          # ✅ 已装，v0.1.0
npx skills add InjectiveLabs/agent-skills --global   # ✅ 已装 → ~/.claude/skills/（21 个 skill）
git clone https://github.com/InjectiveLabs/mcp-server vendor/injective-mcp-server && npm install && npm run build   # ✅ 已构建
```

### ainj CLI
命令：`ainj cli`（跑 injectived）、`ainj install`（配置 harness）、`ainj mcp <server>`（启动 MCP）、`ainj status`、`ainj skills`、`ainj update`。

### 已安装的 Agent Skills（`~/.claude/skills/`，Claude Code 全局可用）
`injective-cli`, `injective-evm-developer`, `injective-mcp-servers`, `injective-trading-market-data`, `injective-trading-account`, `injective-trading-autosign`, `injective-trading-bridge`, `injective-trading-chain-analysis`, `injective-trading-staking`, `injective-trading-tokens`, `injective-wallet-ops`, `injective-funding`, `injective-faucet`, `injective-frontend-wallet`, `injective-usdc-integration`, `injective-rfq-integrations`, `injective-docs-style`, `injective-ai-cost-optimization` 等。
开发时按需触发，如 EVM 合约开发用 `injective-evm-developer`，行情接入用 `injective-trading-market-data`。

### MCP Servers（配置见本仓库 `.mcp.json`）
1. **Injective Documentation MCP**（托管，无需安装）：`https://docs.injective.network/mcp`（streamable HTTP），工具 `SearchInjectiveDocs` — 查官方文档并带引用，**开发中优先用它核对事实**
2. **Injective MCP Server**（本地，`vendor/injective-mcp-server/dist/mcp/server.js`，env `INJECTIVE_NETWORK=mainnet|testnet`）：钱包管理（generate/import/list/remove）、`market_list`、`market_price`、下单交易、跨链桥、raw EVM tx 等全量交易能力

## 7.5 网络可达性（2026-07-25 实测，重要）

- **Injective Labs 官方基础设施（`sentry.*`、indexer/exchange API、testnet k8s 端点）对中国大陆网络返回 403（地域封锁）**；Hyperliquid API 不受影响
- 可用替代：**社区端点 publicnode**（实测 200）：
  - LCD/REST: `https://injective-rest.publicnode.com`
  - RPC: `https://injective-rpc.publicnode.com`
- **链上 LCD 可以直接查 exchange module**（不依赖被封的 indexer）：`GET /injective/exchange/v1beta1/derivative/markets?status=Active` 返回全部市场 + `perpetual_info`（funding_interval、hourly_interest_rate、hourly_funding_rate_cap、cumulative_funding、cumulative_price）+ mark_price（定点数，除以 `10^quote_decimals` 还原）
- 当前周期费率估算公式（`src/connectors/injective.ts` 实现）：`est = clamp(hourly_interest_rate + (cumulative_price/elapsed×3600)/mark_price, ±cap)`；BTC 实测 ~0.0015%/h 与 HL 同标的量级一致。**待可访问 indexer 时用其 fundingRates 交叉验证**
- 生产部署应放在海外服务器（HK/SG/US），届时可切回官方端点（env `INJ_LCD_URL`）；本地开发用 publicnode
- 本机 MCP server（`vendor/injective-mcp-server`）访问的也是官方端点，**在国内网络下工具调用可能 403**，同样受此限制

## 8. 套利场景要点备忘

- Injective perp 资金费率、标记价从 Indexer（`IndexerGrpcDerivativesApi.fetchMarkets` 返回 `perpetualMarketInfo`/`perpetualMarketFunding`）或 oracle module 读取
- **HL ↔ INJ 跨所套利**：两边都是链上订单簿永续。对比维度：资金费率差、同标的盘口价差、手续费（INJ 有 maker rebate）
- INJ 侧下单延迟 ~650ms 出块 + FBA 批量撮合，**不适合对延迟极端敏感的策略**，适合资金费/基差类中低频策略
- 资金流：USDC 可经 Circle/官方桥入 Injective；交易保证金进 subaccount
- 生产清单：私钥用 env/keyring 管理（MCP 钱包 keystore 或自管）、testnet 全流程验证后切 mainnet（改 chainId + 端点常量即可）
