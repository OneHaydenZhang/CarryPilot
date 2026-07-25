# CarryPilot · HARNESS

> 任何 harness/编排器操作本项目时的接线说明：有哪些工具面、怎么调、什么不能碰。

## 对外暴露的 Agent 接口（A2A / MCP）

- **Agent Card**：`GET /.well-known/agent-card.json`（公网，无鉴权）——身份、技能、约束、风险声明、`additionalInterfaces`（A2A/MCP/HTTP 三种接入点）
- **A2A（Agent2Agent 协议）**：`POST /api/a2a` — 标准 JSON-RPC 2.0 `message/send`；文本 part 走 `agentApi.classify()` 意图识别，返回文本 part（人读）+ data part（机器读）。`tasks/get`/`tasks/cancel` 返回 -32001（同步完成，不留任务状态）。实现在 `src/web/agentApi.ts::handleA2A`
- **MCP（Model Context Protocol）**：`POST /mcp` — Streamable HTTP，无状态（每请求现建 `McpServer`+`transport`，用完关闭）。暴露 `get_funding_rates`、`find_arbitrage` 两个 tool，内部转调 `/api/agent/query`。实现在 `src/web/mcpServer.ts`
- **技能 → HTTP 映射**（当前免鉴权只读；写操作需钱包签名会话）：
  | Skill | 端点 | 说明 |
  |---|---|---|
  | `funding_rates` / `arbitrage_opportunity` | `GET/POST /api/agent/query` | 对话式查询，A2A/MCP 底层都转调这个 |
  | `opportunity_discovery` | `GET /api/scan` | 全市场成本后候选 + 拒绝码 + 叙述 + 收益表 |
  | `funding_history` | `GET /api/funding-history?coin=X` | 7 天小时费率序列 |
  | `agent_operation` | `POST /api/agents`（Bearer 会话） | 创建/启停套利 Agent（钱包签名登录后） |
  | `health` | `GET /api/health` | 存活与引擎版本 |
- **x402（付费报告，规划中）**：`/api/agent/report` 走 x402 中间件收 USDC；402 报价握手已在 `scripts/x402-spike.ts` 验证跑通，生产接线（金库钱包/facilitator key/挂路由）待做，见 `docs/specs/carry-mvp-gaps.md` 工作项 C

## 内部工具面（开发/运维 harness 用）

- **运行**：`npm run web`（服务）· `npm run scan`（单轮扫描）· `BASE_URL=... npx tsx scripts/acceptance.ts`（22 用例验收）
- **部署**：git push → 服务器 `git pull && sudo systemctl restart carrypilot`（详见 ~/.claude 记忆 kuroai-infra）
- **MCP**：`.mcp.json` — injective-docs（查文档带引用）、injective（链上操作）
- **Skills**：`.claude/skills/` 20 个 Injective 官方 skill（随仓库提交）
- **截图**：服务器有 chromium，`chromium --headless --no-sandbox --screenshot=... URL`

## 禁区（harness 不得做）

- 不 commit `.env`、`data/`、任何私钥/token；公开仓库，diff 先自查
- 不绕过 RiskGuard 上限（LIMITS in src/core/agents.ts）改代码放大杠杆
- 不在 UI/文档暴露：服务器 IP/主机名、模型路由商与版本号（只说 DeepSeek/Claude 等家族名）
- git 提交者 = 用户本人（repo-local config 已设），不加 AI 署名

## 关键不变量（改前先读 agent/MEMORY.md）

引擎 tick=10min；虚拟/实盘按 mode 隔离；换仓需过磨损核算；LLM 失效降级纯规则。
