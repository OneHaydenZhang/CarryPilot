# 稳定性与 Harness 工程设计

> 7×24 无人值守交易系统的工程骨架设计。`src/` 中的雏形即按此实现。最后核对时间：2026-07-25

## 1. 总体形态：单进程监督循环（v0）→ 进程分离（v1）

v0（当前雏形）：一个 Node 进程内跑 supervisor loop，模块间事件解耦。够黑客松 + 早期实盘。
v1 触发条件：策略 >2 个或需要独立部署数据采集时，按 L0/L1 拆进程（数据采集、执行、决策各自独立，经 SQLite/队列通信），任一进程崩溃不拖垮执行层。

## 2. 核心机制（雏形已实现的骨架）

### 2.1 Supervisor / Tick 循环
- 主循环 = 固定间隔 tick（默认 60s，费率类策略足够），每个 tick：采集 → 扫描 → （决策）→（执行）→ 落账
- **每个 tick 有硬超时**（如 30s），超时记录并跳过，绝不阻塞下一 tick
- 单 tick 内任何模块抛错 → 捕获、计数、继续；**连续 N 次失败 → 进入 SAFE 模式**（撤单、停开仓、只允许平仓）并告警

### 2.2 错误分级与退避
| 级别 | 例子 | 处理 |
|---|---|---|
| 瞬时 | 网络超时、429 限频 | 指数退避重试（jitter），限频读 `userRateLimit` 主动降速 |
| 状态可疑 | 下单响应超时（不知是否成交） | **先查证再重试**（orderStatus by cloid），杜绝重复下单 |
| 致命 | 签名错误、余额异常、reconcile 不一致 | SAFE 模式 + 告警，等人工 |

### 2.3 幂等与对账（资金安全的根）
- 所有订单带 **cloid**（客户端生成 uuid→16字节hex）：崩溃重启后用 cloid 查证未知状态订单
- 启动时与每 N 个 tick：`clearinghouseState`（HL）/ subaccount 查询（INJ）与本地台账 **reconcile**，以交易所为准；发现幽灵仓位 → SAFE 模式
- 台账 SQLite 单写者，先写意图（intent）再执行，执行结果回填 —— 崩溃后可知「哪一步做到一半」

### 2.4 Kill switch / Dead man's switch
- HL：进程每 tick 续期 `scheduleCancel`（如 now+5min）→ 进程死掉，交易所侧自动撤全部挂单
- 本地：`data/KILL` 文件存在即进入 SAFE 模式（人工干预通道，不需要改代码/发信号）
- RiskGuard 硬限额：单标的最大名义、总敞口、日亏损上限（触发即全平并停机）

### 2.5 配置与密钥
- 全部经 `src/config.ts` 的 zod schema 校验后使用；缺失/非法 → 启动即失败（fail fast），绝不带默认密钥运行
- `NETWORK` 单一开关派生所有端点；mainnet 下启动时打印醒目警示

### 2.6 可观测性
- 结构化 JSON 日志（stdout，一行一事件：tick/opportunity/decision/order/error），生产收集交给 pm2/容器日志管道
- 心跳：每 tick 写 `data/heartbeat`（时间戳），外部 watchdog（cron/uptime 监控）检测失联
- 每笔 LLM 决策、每个机会快照落 SQLite —— 复盘与 eval 的数据资产

## 3. 部署基线（生产）
- pm2（`pm2 start npm -- run dev` + `max_restarts` + `exp_backoff_restart_delay`）或 Docker + `restart: unless-stopped`
- 时钟：NTP 同步（HL nonce 是毫秒时间戳，时钟漂移会拒单）
- 单区域低延迟非必须（低频策略），但**网络出口稳定**必须（长连 WS）

## 4. 雏形代码地图（`src/`）

```
src/config.ts          env → zod 校验 → 全局 Config（NETWORK 派生端点）
src/lib/logger.ts      结构化 JSON 日志
src/lib/http.ts        fetch + 超时 + 指数退避重试
src/connectors/
  hyperliquid.ts       Info API：metaAndAssetCtxs / predictedFundings（免key）
  injective.ts         sdk-ts Indexer：perp 市场 + 资金费率（免key）
src/core/
  scanner.ts           L2 信号层：HL站内 carry 年化 + HL↔INJ 费率差，扣费后排序
  risk.ts              RiskGuard：限额白名单硬校验（v0 全部 dry-run）
  supervisor.ts        tick 循环、超时、错误计数、SAFE 模式、心跳
src/index.ts           入口：组装 + 启动（--once 单跑一轮）
```
执行层（下单）与 L3（LLM 决策）在 PRD 后接入——接口位已留（`Decision`/`RiskVerdict` 类型）。
