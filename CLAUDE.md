# KuroAI-INJ — Hyperliquid × Injective 套利 AI 平台

基于 Hyperliquid 与 Injective 的套利 AI 平台。早期目标 AdventureX 2026 黑客松（Injective 赛道），随后迭代为真实生产项目——**一切按生产级 / mainnet 标准开发**。

## 开工前必读（按需）

| 文档 | 内容 |
|---|---|
| `docs/knowledge/hyperliquid.md` | HL 全技术体系：Info/Exchange/WS API、签名两套方案、nonce/API wallet、限频、精度、SDK、HyperEVM |
| `docs/knowledge/injective.md` | INJ 全技术体系：EVM(chainId 1776)/CosmWasm、exchange module、precompiles、MTS、SDK、网络端点 |
| `docs/knowledge/ai-stack.md` | OpenRouter 接入、agent 拓扑（轻量 orchestrator + Vercel AI SDK）、已装 AI 工具清单 |
| `docs/knowledge/arbitrage.md` | 套利分类学、HL 资金费率机制与公式、可行策略模式 A/B/C/D 及盈亏平衡数学 |
| `docs/knowledge/agent-patterns.md` | Agent 架构模式全景、交易 agent 分层（L0-L4 + RiskGuard）、LLM 工程要点 |
| `docs/knowledge/harness-engineering.md` | 稳定性工程：supervisor/tick、错误分级、幂等对账、kill switch、`src/` 代码地图 |
| `docs/playbooks/prd-to-dev.md` | 收到 PRD 后的开发方案生成流程（强制走一遍） |

## 已就绪的工具链（**全部项目维度**，不要装到全局）

- **MCP**（项目 `.mcp.json`）：`injective-docs`（托管 HTTP，工具 `SearchInjectiveDocs`——**写任何 Injective 相关代码前先用它核对事实**）；`injective`（本地 `vendor/injective-mcp-server`，全量钱包/行情/交易能力，`INJECTIVE_NETWORK=mainnet`；国内网络下可能 403，见 injective.md §7.5）
- **Skills**：20 个 Injective 官方 skill 在**本仓库 `.claude/skills/`**（随 git 提交，`injective-evm-developer`、`injective-trading-market-data` 等），按需触发；项目自有 skill 也放这里
- **CLI**：`ainj` 是项目 devDependency —— `npx ainj cli` = injectived、`npx ainj mcp <server>`、`npx ainj skills`
- **约定：未来任何安装（npm 包、skill、MCP、工具）一律项目维度**（devDependency / `.claude/` / `.mcp.json` / `vendor/`），不写入 `~/`
- clean clone 恢复：`bash scripts/setup.sh`

## Harness 雏形（已可运行）

- `npm run scan` — 单轮 dry-run：拉 HL 全市场费率 + INJ 全市场费率（LCD），扫描 carry 与跨所费率差机会，结构化日志输出（已实测跑通）
- `npm run dev` — supervisor 常驻循环（60s tick、超时保护、连续失败进 SAFE 模式、`data/KILL` 人工熔断、心跳文件）
- 网络注意：INJ 官方端点对国内网络 403，数据走 publicnode LCD（`INJ_LCD_URL` 可覆盖）；生产部署放海外服务器

## 硬性规则

0. **本仓库在 GitHub 公开**（github.com/OneHaydenZhang/KuroAI-INJ）：任何隐私数据（密钥、地址+持仓、交易记录、Telegram token/chat id、服务器信息）永不入库；commit 前自查 diff。git 提交者为用户本人身份（OneHaydenZhang），commit message 不加 AI 署名
1. **资金安全**：LLM 输出永远只是「建议」，仓位/限额/止损由确定性 RiskGuard 代码强制；金额用 string/bigint/decimal，禁止 float
2. **密钥**：私钥/API key 只从 env 读取；`.env` 不入库；日志脱敏
3. **网络**：mainnet-first；端点/chainId 只通过 env 切换，不硬编码
4. **事实核对**：INJ 用 Docs MCP、HL 用 `docs/knowledge/hyperliquid.md` + 官方文档（页面 URL 加 `.md` 取 Markdown）；签名/精度/限频细节不凭记忆写
5. **HL 交易 bot 纪律**：API wallet 隔离、nonce 原子递增、`scheduleCancel` 兜底、WS 自动重连
6. **知识同步**：踩坑或发现文档变化后，更新 `docs/knowledge/` 对应文件

## 技术栈（默认选型）

- TypeScript (strict) + Node ≥ 20；LLM 经 OpenRouter（Vercel AI SDK + `@openrouter/ai-sdk-provider`）
- HL 接入：REST/WS 直连 + `@nktkas/hyperliquid`（TS）或官方 Python SDK（签名参考基准）
- INJ 接入：`@injectivelabs/sdk-ts`（querying + tx）；合约需求走 EVM（Hardhat/Foundry）+ precompiles
- 数据落盘：SQLite（决策/成交台账）

## 目录约定

```
docs/knowledge/   # 领域知识（HL/INJ/AI 栈）——长期维护
docs/playbooks/   # 流程规范（PRD→开发方案等）
docs/specs/       # 每个 feature 的需求解构文档（PRD 来了以后建）
src/              # 业务代码（PRD 来了以后建结构）
scripts/          # 安装/运维/testnet 验证脚本
vendor/           # 第三方源码（injective-mcp-server，git-ignored）
.claude/skills/   # 项目自有 skill
```
