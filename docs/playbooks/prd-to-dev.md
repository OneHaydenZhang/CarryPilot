# PRD → 开发方案生成流程（Playbook）

> 收到 PRD 后，AI 助手按此流程产出严谨、生产级的开发方案。

## 第 0 步：事实核对（强制）
- 涉及 Injective 的任何 API/合约/模块行为：先用 **`SearchInjectiveDocs`（Docs MCP）** 核对，不凭记忆写代码
- 涉及 Hyperliquid：以 `docs/knowledge/hyperliquid.md` 为基线，有疑问 fetch 官方文档对应页 `.md`
- 精度/限频/签名等易错细节，必须引用文档原文确认

## 第 1 步：需求解构
产出 `docs/specs/<feature>.md`，包含：
1. 用户故事 → 验收标准（可测试的行为描述）
2. 涉及的外部系统（HL API / INJ 模块 / LLM）与数据流图
3. 风险清单：资金安全、精度、限频、延迟、双腿失败等
4. 明确 **不做** 的范围

## 第 2 步：技术方案
1. 模块划分对齐 `docs/knowledge/ai-stack.md` 的 agent 拓扑
2. 每个外部调用注明：端点、限频预算、失败重试策略、幂等性
3. 涉及资金操作 → 必须经过 RiskGuard 规则层，列出规则
4. 网络策略：**本项目 mainnet-first**（产品定位为正式网生产部署）。所有配置通过 env 切换（`NETWORK=mainnet|testnet`），代码不硬编码端点；涉及真实资金的新策略首次上线可先用 testnet 或 dry-run 模式验证一轮，验证完立即回 mainnet

## 第 3 步：实现规范
- TypeScript strict；金额一律用字符串/bigint/decimal 库，**禁止 float 算钱**
- 私钥只从 env/keyring 读取；`.env` 永不入库；日志脱敏
- 每个策略模块配 dry-run 模式（signal 记录但不下单）
- 测试：纯逻辑单测 + testnet 集成测试脚本（`scripts/`）

## 第 4 步：交付检查
- [ ] testnet 端到端跑通（含失败路径：撤单、断线重连、限频退避）
- [ ] `scheduleCancel`（HL）等 dead-man-switch 已配置
- [ ] 监控/日志足以事后复盘每笔决策（LLM 决策 JSON 落库）
- [ ] README/知识文档同步更新
