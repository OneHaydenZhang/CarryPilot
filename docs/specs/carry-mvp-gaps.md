# CarryPilot MVP PRD — 差距分析与叠加工作项

> 对照新 PRD（`docs/产品文档/CarryPilot_Agent_PRD_MVP.docx`）与当前 v0.6 现状。
> 原则：**不打破现状，纯叠加**。最后更新 2026-07-25。

## 一、新 PRD vs 现状对照

| PRD 模块 | 现状 | 差距 |
|---|---|---|
| Market Data Collector | ✅ HL Info/Exchange + funding history | 无 |
| Opportunity Engine | ✅ S1 引擎、拒绝码、叙述、收益表 | 无 |
| Cost Calculator | ✅ 成本瀑布（手续费+滑点+准备金） | 无 |
| Risk Engine | ✅ 硬门 + 逐仓风险分级 + 48h 预测 | 无 |
| AI Agent Layer | ✅ LLM 评估门 + 记忆 + 结构化偏好 | 无 |
| Backtest/Paper | 🟡 有虚拟盘实时记账；无历史回测 | 历史回测（P1） |
| **Level 1 Research** | ✅ 五中心 + 对外查询端点 | 无 |
| **Level 2 Assisted Exec** | 🟡 有实盘下单，但走「创建 Agent」路径 | **缺对话式「确认后下单」交互** |
| Level 3 Autonomous | ✅ Agent 自动模式（内测限额） | 无 |
| x402 Payment (P0) | ❌ | **需集成**（已验证可行，见三） |
| Receipt 存证 (P1) | 🟡 本地 sha256 哈希；未上链 | 上链锚定（P1） |
| Agent Identity (P2) | 🟡 有 Agent Card 端点；未 ERC-8004 注册 | 链上注册（P2） |

## 二、三大叠加工作项（用户本轮指定）

### 工作项 A：对话平台 + 完善下单体系（Level 2）
参考 manekiai 的对话框 + 交易确认弹窗，适配套利交易。

- **前端**：App 内嵌浮动对话框（复用现有 `/api/agent/query` 意图识别）
  - 用户问「BTC 能套利吗」→ 返回费率/机会卡片（**卡片显式展示：预期收益规模表 + 风险提示 + 净APR/成本覆盖比**）
  - 用户说「帮我做 1000u」→ 弹出**交易确认弹窗**（两腿结构、名义、预期 8h/日/周收益、风险分级、成本明细）→ 用户确认 → 走已有实盘/虚拟下单链路
- **后端**：`POST /api/agent/intent-order`（会话鉴权）——把对话意图转成一次性下单（复用 `liveOpenCarry` / 虚拟记账），返回确认卡片数据；确认后调 `/api/positions` 开仓
- **复用现状**：下单/风控/双腿回滚已完备，只需加「一次性下单（非 Agent 托管）」入口 + 确认 UI
- 工作量：中（前端对话+弹窗组件 + 1 个后端端点）

### 工作项 B：对外 Agent 能力（MCP + HTTP + A2A）— **已完成**
把「对话查资费 + 查套利机会」打包成对外可调用 Agent。

- ✅ **已实现**：
  - `GET /.well-known/agent-card.json` — 标准 Agent Card（身份/技能/约束/风险 + `additionalInterfaces` 声明三种接入点）
  - `GET|POST /api/agent/query` — 意图识别（funding_rates / arbitrage_opportunity）→ 返回费率/机会（HTTP+JSON 底座）
  - `POST /api/a2a` — **A2A 协议**：标准 JSON-RPC 2.0 `message/send`，`src/web/agentApi.ts::handleA2A`
  - `POST /mcp` — **MCP server**（Streamable HTTP，无状态）：`get_funding_rates` / `find_arbitrage` 两个 tool，内部转调 `/api/agent/query`，`src/web/mcpServer.ts`
  - **首页透出**：landing「把 CarryPilot 当 Agent 调用」板块——HTTP/A2A/MCP 三张卡片 + curl 示例 + MCP client config + x402 路线图说明
  - 验证：22 项验收全过（含新路由未破坏既有接口）；A2A 用 curl 手测 message/send 正常路径 + 4 类错误路径（-32600/-32601/-32602/-32001）；MCP 用 SDK Client（`StreamableHTTPClientTransport`）实测 `tools/list` + 两个 `tools/call` 均返回预期数据
- 🔲 **待做（下一迭代）**：外部第三方 harness（非自测）实际接入验证；A2A `tasks/get` 若未来加异步长任务需要补状态存储

### 工作项 C：x402 集成（P0）— **本轮已验证可行**
其他 Agent 付 USDC 获取完整报告。

- ✅ **已验证（本轮 spike，`scripts/x402-spike.ts`）**：
  - 包 `@injectivelabs/x402`（EIP-3009 gasless USDC）；testnet USDC `0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d`（CAIP2 `eip155:1439`）
  - **402 报价握手跑通**：受保护路由无支付 → HTTP 402 + PaymentRequirements + PAYMENT-REQUIRED header ✅
  - 客户端 `createInjectiveClient` 正确解析 402 并签 EIP-3009；结算被 Injective testnet RPC 的**地域封锁 403** 挡住（非代码问题，US 服务器可达）
- 🔲 **待做（下一迭代）**：
  1. 生产集成：`/api/agent/report`（完整报告，付费）走 x402 中间件；`/api/scan`、`/api/agent/query`、`/.well-known/*` 保持免费（评委/公开可用）
  2. 服务器是 raw http（非 Express）→ 用 protocol 层函数（`createPaymentPayload`/`verifyPaymentRequest`/`createFacilitator`）手写握手，或对该路由挂 Express
  3. 金库钱包（收款）+ facilitator key（结算）配 env；RPC 指向可达端点
  4. **在 US GCP 服务器上用充值了 testnet USDC 的钱包跑端到端结算**，记录 tx hash
- 方案推荐：**先 testnet 打通端到端**（水龙头领 USDC → spike 从服务器跑通结算 → 拿 tx hash），再上主网小额

## 三、优先级建议

P0（比赛闭环）：工作项 A 对话+确认下单（Level 2 是评分点）、工作项 B 首页透出 + MCP
P1：x402 testnet 端到端结算（证据链）、历史回测
P2：Receipt 上链、ERC-8004 注册

## 四、不变的约束

所有叠加遵守 `agent/SOUL.md` 铁律与 `agent/HARNESS.md` 禁区：确定性引擎出数、风控不越权、对外脱敏、公开仓库不含密钥。
