import type { Candidate } from '../core/candidates.js';
import { CONFIG } from '../core/candidates.js';
import { config } from '../config.js';

/**
 * 对外 Agent 能力（A2A / MCP 的 HTTP 地基）。
 * 只读、免鉴权、纯查询：意图识别 → 返回费率现状 / 套利机会。不下单（下单需钱包会话）。
 * 对应新 PRD：把「对话咨询资费与套利机会」打包成对外可调用 Agent。
 */

export interface RateRow {
  coin: string;
  hourlyFundingPct: number;
  annualizedPct: number;
  markPx: number;
  hasSpot: boolean;
}

const BASE_URL = process.env.PUBLIC_BASE_URL ?? '';

export function agentCard() {
  return {
    protocolVersion: '0.2',
    name: 'CarryPilot',
    description:
      'AI 资金费率套利研究 Agent。查询 Hyperliquid 全市场资金费率现状与扣完成本后的套利机会（现货多+永续空，市场中性）。只出研究结论，不构成投资建议。',
    version: '0.6.0',
    provider: { organization: 'CarryPilot', url: BASE_URL || undefined },
    url: BASE_URL ? `${BASE_URL}/api/agent/query` : '/api/agent/query',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'funding_rates',
        name: '资金费率查询',
        description: '查询 Hyperliquid 某标的或全市场的当前资金费率、年化与是否可对冲。',
        tags: ['funding', 'rates', 'hyperliquid'],
        examples: ['BTC 现在资金费率多少', '哪些币费率最高', 'ETH funding rate'],
      },
      {
        id: 'arbitrage_opportunity',
        name: '套利机会查询',
        description: '返回扣完全部成本后的市场中性套利候选：净APR、组合结构、成本、拒绝原因。',
        tags: ['arbitrage', 'carry', 'opportunity'],
        examples: ['现在有什么套利机会', 'BTC 值得做套利吗', 'best carry trade now'],
      },
    ],
    constraints: { venues: ['hyperliquid'], strategy: 'S1_SPOT_PERP', readOnly: true, network: config.network },
    risk: {
      disclaimer: '研究结论，非投资建议，不承诺收益。资金费率随市场快速变化。',
    },
    // x402 付费能力声明（占位；启用后指向受保护的完整报告端点）
    payments: process.env.X402_ENABLED === 'true' ? { protocol: 'x402', asset: 'USDC', network: 'injective-testnet', endpoint: '/api/agent/report' } : undefined,
  };
}

type Intent = 'funding_rates' | 'arbitrage_opportunity' | 'unknown';

const COINS_RE = /\b([A-Z]{2,10})\b/;

/** 极简意图识别：关键词 + 标的提取。够对话式查询用；复杂 NLU 由调用方 LLM 负责。 */
export function classify(text: string): { intent: Intent; coin: string | null } {
  const t = text.toLowerCase();
  const raw = text.toUpperCase();
  const coinMatch = raw.match(COINS_RE);
  const coin = coinMatch && !['THE', 'NOW', 'BEST', 'AND', 'FOR'].includes(coinMatch[1]!) ? coinMatch[1]! : null;
  const arb = /套利|机会|carry|arbitrage|值得|做单|opportunit/.test(t);
  const rate = /费率|资费|funding|rate|年化|apr/.test(t);
  if (arb) return { intent: 'arbitrage_opportunity', coin };
  if (rate) return { intent: 'funding_rates', coin };
  return { intent: 'unknown', coin };
}

export function answerRates(rates: RateRow[], coin: string | null) {
  if (coin) {
    const r = rates.find((x) => x.coin === coin);
    if (!r) return { intent: 'funding_rates', found: false, message: `未找到 ${coin} 的 Hyperliquid 永续市场。` };
    const dir = r.hourlyFundingPct >= 0 ? '多头付给空头（做空可收）' : '空头付给多头（做多可收）';
    return {
      intent: 'funding_rates',
      found: true,
      coin,
      hourlyFundingPct: r.hourlyFundingPct,
      annualizedPct: r.annualizedPct,
      hasSpot: r.hasSpot,
      message: `${coin} 当前资金费率 ${r.hourlyFundingPct.toFixed(5)}%/h（年化约 ${r.annualizedPct.toFixed(1)}%），${dir}。${r.hasSpot ? '有现货可对冲，可构建站内套利组合。' : 'HL 无现货，无法站内对冲，仅可观察。'}`,
    };
  }
  const top = [...rates].sort((a, b) => Math.abs(b.hourlyFundingPct) - Math.abs(a.hourlyFundingPct)).slice(0, 8);
  return {
    intent: 'funding_rates',
    top: top.map((r) => ({ coin: r.coin, hourlyFundingPct: r.hourlyFundingPct, annualizedPct: r.annualizedPct, hasSpot: r.hasSpot })),
    message: `当前费率绝对值最高的标的：${top.map((r) => `${r.coin} ${r.hourlyFundingPct.toFixed(4)}%/h`).join('、')}。`,
  };
}

export function answerOpportunities(candidates: Candidate[], coin: string | null) {
  const s1 = candidates.filter((c) => c.strategy === 'S1_SPOT_PERP');
  if (coin) {
    const c = s1.find((x) => x.asset === coin);
    if (!c) return { intent: 'arbitrage_opportunity', found: false, message: `${coin} 暂无可评估的站内套利候选。` };
    return {
      intent: 'arbitrage_opportunity',
      found: true,
      candidate: slim(c),
      message: c.decision === 'ACCEPTED' ? `✅ ${coin} 存在套利机会：${c.narrative.zh}` : `✖ ${coin} 暂无机会（${c.rejectionCodes.join(',')}）：${c.narrative.zh}`,
    };
  }
  const accepted = s1.filter((c) => c.decision === 'ACCEPTED').sort((a, b) => b.netApr - a.netApr);
  if (!accepted.length)
    return {
      intent: 'arbitrage_opportunity',
      accepted: [],
      message: '当前全市场无扣完成本后为正的套利机会——基准费率偏低，成本盖过收益。这是正确的诚实结论，Agent 会在费率异常升高时出手。',
    };
  return {
    intent: 'arbitrage_opportunity',
    accepted: accepted.slice(0, 5).map(slim),
    message: `当前 ${accepted.length} 个成本后为正的机会，最优：${accepted[0]!.asset}（净APR ${accepted[0]!.netApr.toFixed(1)}%）。`,
  };
}

function slim(c: Candidate) {
  return {
    asset: c.asset,
    decision: c.decision,
    rejectionCodes: c.rejectionCodes,
    grossApr: c.grossApr,
    netApr: c.netApr,
    costCoverage: c.costCoverage,
    breakevenHours: c.breakevenHours,
    horizonHours: c.horizonHours,
    tags: c.tags,
    legs: c.legs.map((l) => ({ venue: l.venue, market: l.market, instrument: l.instrument, side: l.side, hourlyFundingPct: l.hourlyFundingPct })),
    payouts: c.payouts,
    narrative: c.narrative.zh,
  };
}

export { CONFIG };
