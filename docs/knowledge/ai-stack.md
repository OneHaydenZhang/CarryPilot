# AI 技术栈：LLM、Agent 框架与工具链

> 本项目的 AI 层选型与接入方法。最后核对时间：2026-07-25

## 1. LLM 层：OpenRouter（已定）

- 统一 OpenAI 兼容 API：`https://openrouter.ai/api/v1/chat/completions`
- 认证：`Authorization: Bearer $OPENROUTER_API_KEY`（放 `.env`，勿入库）
- 模型用 `<vendor>/<model>` 命名（如 `anthropic/claude-sonnet-5`、`deepseek/deepseek-chat` 等），可按任务分层：
  - **决策/策略推理**：强模型（低频、高价值调用）
  - **数据清洗/信号摘要**：便宜快模型（高频调用）
- 支持 `tools`（function calling）、`response_format: json_schema`（结构化输出）、streaming
- TS 接入推荐 **Vercel AI SDK**（`ai` + `@openrouter/ai-sdk-provider`），也可直接用 `openai` SDK 改 `baseURL`

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const { object } = await generateObject({
  model: openrouter('anthropic/claude-sonnet-5'),
  schema: arbitrageSignalSchema,   // zod schema → 结构化决策输出
  prompt: '...market snapshot...',
});
```

## 2. Agent 框架决策

结论：**黑客松阶段用「轻量自研 orchestrator + Vercel AI SDK」，预留 LangGraph.js 升级路径。**

理由：
- 套利 agent 的主循环本质是 **确定性的 pipeline**（采集行情 → 计算机会 → LLM/规则决策 → 风控 → 执行 → 复盘），LLM 只在「决策/解释」节点介入。重框架（LangGraph/DeerFlow）的图编排在这个规模下是负担而非收益
- Vercel AI SDK 提供 tool-calling loop、结构化输出、streaming、多 provider（OpenRouter）——已覆盖 80% 框架价值
- 若后续 PRD 出现多 agent 协作/人审插入/长时间状态机，再迁移到 **LangGraph.js**（graph + checkpoint 持久化最成熟）；节点函数保持纯函数即可平滑迁移

### 建议的 Agent 拓扑（v0）
```
┌─────────────── Orchestrator (确定性循环, 非LLM) ───────────────┐
│                                                                │
│  MarketWatcher ──► OpportunityScanner ──► StrategyAgent(LLM)   │
│  (HL WS + INJ       (价差/资金费率        (评估机会、生成         │
│   indexer 轮询)      规则计算)             带理由的决策JSON)      │
│                                              │                 │
│                                     RiskGuard(纯规则,LLM不可越权)│
│                                              │                 │
│                                        Executor ──► Ledger     │
│                                        (HL/INJ 下单)  (SQLite)  │
└────────────────────────────────────────────────────────────────┘
```
**铁律：LLM 输出只作为「建议」进入 RiskGuard，仓位/限额/止损由确定性代码强制执行。**

## 3. 已就绪的 AI 工具（全部项目维度，不污染全局）

| 工具 | 状态 | 用法 |
|---|---|---|
| Injective Docs MCP | `.mcp.json` 已配（托管 HTTP） | 工具 `SearchInjectiveDocs`，查官方文档带引用 |
| Injective MCP Server | `vendor/injective-mcp-server` 已 build，`.mcp.json` 已配 | 钱包/行情/交易/桥/EVM tx（注意：走官方端点，国内网络可能 403，见 injective.md §7.5） |
| Injective Agent Skills ×20 | **本仓库 `.claude/skills/`（随 git 提交）** | 按需自动触发（EVM 开发、行情、账户、桥…） |
| ainj CLI | 项目 devDependency v0.1.0 | `npx ainj cli`（injectived）、`npx ainj mcp`、`npx ainj skills` |

## 4. 未来接入清单（占位）

- [ ] Hyperliquid MCP（如社区出现成熟实现；当前直接用 REST/WS + SDK）
- [ ] 价格聚合 oracle（Pyth/Chainlink）数据源
- [ ] 回测数据管道（HL `candleSnapshot` + INJ indexer 历史成交）
- [ ] 项目自有 skill：`.claude/skills/` 下按 `<skill-name>/SKILL.md` 结构添加（frontmatter: name + description）
