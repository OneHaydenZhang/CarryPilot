import { createHash, randomUUID } from 'node:crypto';
import { store, saveStore, type AgentRecord, type PositionRecord } from './store.js';
import type { Candidate } from './candidates.js';
import { CONFIG } from './candidates.js';
import { evaluateCandidate, llmEnabled } from './llm.js';
import { tryDebit, POINTS } from './points.js';
import { log } from '../lib/logger.js';

/**
 * Carry Agent 引擎（Maneki 式架构）：每个 Agent 按风格自主决策，
 * PAPER 模式模拟记账，LIVE 模式经 executor 真实下单（HL API wallet，无提币权限）。
 * 全部决策为确定性规则；每步写入决策日志供用户观测。
 */

export const STYLE_PARAMS = {
  conservative: { label: '保守', minEntryNetApr: 15, exitNetApr: 2, positionRatio: 0.3 },
  balanced: { label: '均衡', minEntryNetApr: 8, exitNetApr: 0, positionRatio: 0.5 },
  aggressive: { label: '激进', minEntryNetApr: 4, exitNetApr: -2, positionRatio: 0.8 },
} as const;

export const LIMITS = {
  maxAgentsPerUser: 5,
  maxPaperCapitalUsd: 100_000,
  maxLiveCapitalUsd: 2_000, // 实盘硬顶（RiskGuard，UI 不可越过）
  maxNotionalUsd: 50_000,
  minCapitalUsd: 50,
} as const;

export interface LiveExecutor {
  openCarry(owner: string, asset: string, notionalUsd: number): Promise<{ fills: unknown[]; spotMarket: string; perpMarket: string }>;
  closeCarry(owner: string, position: PositionRecord): Promise<{ fills: unknown[] }>;
}

function agentLog(agent: AgentRecord, msg: string): void {
  agent.log.push({ at: new Date().toISOString(), msg });
  if (agent.log.length > 60) agent.log.splice(0, agent.log.length - 60);
}

function openPosition(agent: AgentRecord, c: Candidate, notionalUsd: number): PositionRecord {
  const feePct = CONFIG.takerFeePct.hyperliquid ?? 0.045;
  const openCostUsd = notionalUsd * ((feePct * 2 + CONFIG.slippageReservePct / 2) / 100);
  const now = new Date().toISOString();
  const spotLeg = c.legs.find((l) => l.instrument === 'spot');
  const perpLeg = c.legs.find((l) => l.instrument === 'perp');
  return {
    id: randomUUID().slice(0, 8),
    agentId: agent.id,
    owner: agent.owner,
    mode: agent.mode,
    asset: c.asset,
    spotMarket: spotLeg?.market ?? '',
    perpMarket: perpLeg?.market ?? '',
    notionalUsd,
    entryAt: now,
    entryHourlyFundingPct: perpLeg?.hourlyFundingPct ?? 0,
    entryNetApr: c.netApr,
    currentHourlyFundingPct: perpLeg?.hourlyFundingPct ?? 0,
    fundingAccruedUsd: 0,
    costsPaidUsd: openCostUsd,
    pnlUsd: -openCostUsd,
    status: 'OPEN',
    lastTickAt: now,
  };
}

export function closePosition(pos: PositionRecord, reason: string): void {
  const feePct = CONFIG.takerFeePct.hyperliquid ?? 0.045;
  const closeCostUsd = pos.notionalUsd * ((feePct * 2 + CONFIG.slippageReservePct / 2) / 100);
  pos.costsPaidUsd += closeCostUsd;
  pos.pnlUsd = pos.fundingAccruedUsd - pos.costsPaidUsd;
  pos.status = 'CLOSED';
  pos.closedAt = new Date().toISOString();
  pos.closeReason = reason;
  const record = { ...pos, receiptHash: undefined };
  pos.receiptHash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export interface PositionView extends PositionRecord {
  holdHours: number;
  realizedApr: number;
  risk: { level: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[] };
}

export function viewPosition(pos: PositionRecord): PositionView {
  const end = pos.closedAt ? Date.parse(pos.closedAt) : Date.now();
  const holdHours = Math.max((end - Date.parse(pos.entryAt)) / 3600e3, 1e-6);
  const realizedApr = (pos.pnlUsd / pos.notionalUsd / holdHours) * 24 * 365 * 100;
  const reasons: string[] = [];
  if (pos.status === 'OPEN') {
    if (pos.currentHourlyFundingPct < 0) reasons.push('资金费率已翻负：正在倒贴费率');
    else if (pos.currentHourlyFundingPct < pos.entryHourlyFundingPct / 2) reasons.push('费率较入场衰减超50%');
    if (pos.pnlUsd < -pos.notionalUsd * 0.005) reasons.push('净亏损超过名义 0.5%');
    if (pos.mode === 'LIVE') reasons.push('实盘仓：存在滑点与执行风险');
  }
  const level = reasons.some((r) => r.startsWith('资金费率已翻负')) ? 'HIGH' : reasons.length >= 2 ? 'HIGH' : reasons.length === 1 ? 'MEDIUM' : 'LOW';
  return { ...pos, holdHours, realizedApr, risk: { level, reasons } };
}

/** 引擎主 tick：对每个 RUNNING agent 决策一次 */
export async function tickAgents(candidates: Candidate[], liveExecutor: LiveExecutor | null): Promise<void> {
  const now = Date.now();
  const byAsset = new Map(candidates.filter((c) => c.strategy === 'S1_SPOT_PERP').map((c) => [c.asset, c]));

  // 1. 先更新所有 OPEN 仓位的 funding 累计与当前费率
  for (const pos of store.positions.filter((p) => p.status === 'OPEN')) {
    const c = byAsset.get(pos.asset);
    const perpLeg = c?.legs.find((l) => l.instrument === 'perp');
    if (perpLeg?.hourlyFundingPct != null) pos.currentHourlyFundingPct = perpLeg.hourlyFundingPct;
    const dtH = (now - Date.parse(pos.lastTickAt)) / 3600e3;
    pos.fundingAccruedUsd += pos.notionalUsd * (pos.currentHourlyFundingPct / 100) * dtH;
    pos.pnlUsd = pos.fundingAccruedUsd - pos.costsPaidUsd;
    pos.lastTickAt = new Date(now).toISOString();
  }

  // 2. 逐 agent 决策
  for (const agent of store.agents.filter((a) => a.status === 'RUNNING')) {
    // 积分计费：每个决策 tick 扣费，不足则暂停 Agent（充值后可重启）
    if (!tryDebit(agent.owner, POINTS.perTick, 'tick', `agent ${agent.name} tick`)) {
      agent.status = 'STOPPED';
      agentLog(agent, `⛔ 积分不足（每 tick 消耗 ${POINTS.perTick}），Agent 已暂停。请在收益中心充值 INJ 后重新启动`);
      continue;
    }
    const params = STYLE_PARAMS[agent.style];
    const open = store.positions.find((p) => p.agentId === agent.id && p.status === 'OPEN');

    if (open) {
      const c = byAsset.get(open.asset);
      const netAprNow = c && c.decision === 'ACCEPTED' ? c.netApr : c ? c.netApr : null;
      const shouldExit = open.currentHourlyFundingPct <= 0 || (netAprNow !== null && netAprNow < params.exitNetApr);
      if (shouldExit) {
        const reason = open.currentHourlyFundingPct <= 0 ? 'FUNDING_FLIPPED' : 'NET_APR_BELOW_EXIT';
        if (agent.mode === 'LIVE' && liveExecutor) {
          try {
            const r = await liveExecutor.closeCarry(agent.owner, open);
            open.fills = [...(open.fills ?? []), ...r.fills];
          } catch (err) {
            agentLog(agent, `⚠ 实盘平仓失败，保持持仓待重试: ${String(err).slice(0, 120)}`);
            continue;
          }
        }
        closePosition(open, reason);
        agentLog(agent, `平仓 ${open.asset} · 原因 ${reason} · 净PnL $${open.pnlUsd.toFixed(2)}`);
      }
    } else {
      const eligible = [...byAsset.values()]
        .filter((c) => c.decision === 'ACCEPTED' && (agent.asset === 'ALL' || c.asset === agent.asset) && c.netApr >= params.minEntryNetApr)
        .sort((a, b) => b.netApr - a.netApr);
      if (!eligible.length) {
        const scanned = [...byAsset.values()].filter((c) => agent.asset === 'ALL' || c.asset === agent.asset).length;
        agentLog(agent, `扫描 ${scanned} 个市场：无达到「${params.label}」入场门槛(净APR≥${params.minEntryNetApr}%)的机会，保持空仓`);
      } else {
        const best = eligible[0]!;
        // LLM 评估门：结论否决可阻止开仓；LLM 不可用则按确定性规则继续
        if (llmEnabled()) {
          const verdict = await evaluateCandidate(best);
          if (verdict && !verdict.approve) {
            agentLog(agent, `LLM 否决 ${best.asset}（置信${(verdict.confidence * 100).toFixed(0)}%）：${verdict.reasoning}`);
            continue;
          }
          if (verdict?.approve) agentLog(agent, `LLM 通过 ${best.asset}（置信${(verdict.confidence * 100).toFixed(0)}%）：${verdict.reasoning}`);
        }
        const notional = Math.min(agent.capitalUsd * params.positionRatio, LIMITS.maxNotionalUsd);
        const pos = openPosition(agent, best, notional);
        if (agent.mode === 'LIVE' && liveExecutor) {
          try {
            const r = await liveExecutor.openCarry(agent.owner, best.asset, notional);
            pos.fills = r.fills;
            pos.spotMarket = r.spotMarket;
            pos.perpMarket = r.perpMarket;
          } catch (err) {
            agentLog(agent, `⚠ 实盘开仓失败（未建仓）: ${String(err).slice(0, 120)}`);
            continue;
          }
        }
        store.positions.push(pos);
        agentLog(agent, `开仓 ${best.asset} · 名义 $${notional.toFixed(0)} · 入场净APR ${best.netApr.toFixed(1)}% · 费率 ${pos.entryHourlyFundingPct.toFixed(4)}%/h${agent.mode === 'LIVE' ? ' · 实盘' : ''}`);
      }
    }

    // 3. 收益曲线快照（每 tick，最多 720 点 ≈ 12h 粒度稀释）
    const pnl = store.positions.filter((p) => p.agentId === agent.id).reduce((a, p) => a + p.pnlUsd, 0);
    agent.equitySeries.push({ at: new Date(now).toISOString(), pnlUsd: Number(pnl.toFixed(4)) });
    if (agent.equitySeries.length > 720) agent.equitySeries.splice(0, agent.equitySeries.length - 720);
  }
  saveStore();
  log.info('agents_tick', { agents: store.agents.length, openPositions: store.positions.filter((p) => p.status === 'OPEN').length });
}
