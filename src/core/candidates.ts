import type { HlPerpSnapshot, HlPredictedFunding, HlSpotSnapshot } from '../connectors/hyperliquid.js';
import type { InjPerpSnapshot } from '../connectors/injective.js';

/**
 * 确定性机会引擎（PRD §5）：S1 现货-永续 / S2 跨平台永续-永续。
 * 输出「成本后候选」：Gross 与 Modeled Net 严格分口径，全部候选（含 REJECTED）对外展示。
 * 所有数值由本引擎产生，LLM 层（后续期）只解释不修改。
 */

export const ENGINE_VERSION = 'candidates-0.1.0';

/** 版本化运行配置（PRD 要求阈值可追溯） */
export const CONFIG = {
  universe: ['BTC', 'ETH', 'SOL'] as const,
  horizonHours: 24,
  /** HL 现货 BTC/ETH/SOL 为包装资产（PRD：wrapper_risk 单独标记） */
  wrapperMap: { BTC: 'UBTC', ETH: 'UETH', SOL: 'USOL' } as Record<string, string>,
  takerFeePct: { hyperliquid: 0.045, injective: 0.05, BinPerp: 0.045, BybitPerp: 0.055 } as Record<string, number>,
  slippageReservePct: 0.05,
  /** 不确定性准备金 = 预期 funding 的比例（费率漂移/估算误差） */
  uncertaintyReserveRatio: 0.25,
  minCostCoverage: 2.0,
  minOpenInterestUsd: 2_000_000,
  maxSnapshotAgeMs: 120_000,
} as const;

export interface Leg {
  venue: string;
  market: string;
  instrument: 'spot' | 'perp';
  side: 'long' | 'short';
  price: number | null;
  hourlyFundingPct: number | null; // 正 = 多头付空头
  note?: string;
}

export interface CostItem {
  label: string;
  pct: number; // 占名义本金百分比（往返合计）
}

export interface Payout {
  notionalUsd: number;
  fundingPer8hUsd: number;
  fundingPerDayUsd: number;
  fundingPerWeekUsd: number;
  oneTimeCostUsd: number;
  netPerDayUsd: number;
  netPerWeekUsd: number;
}

export interface Candidate {
  id: string;
  strategy: 'S1_SPOT_PERP' | 'S2_PERP_PERP';
  asset: string;
  legs: Leg[];
  horizonHours: number;
  /** 口径一：机械毛年化（未扣任何成本） */
  grossApr: number;
  /** 持有期毛 funding 收入（% of notional） */
  grossFundingPct: number;
  costs: CostItem[];
  totalCostPct: number;
  /** 口径二：建模净值（扣除全部成本与准备金） */
  netHorizonPct: number;
  netApr: number;
  costCoverage: number;
  decision: 'ACCEPTED' | 'REJECTED';
  rejectionCodes: string[];
  flags: string[];
  observedAt: string;
  /** 确定性生成的现状阐述（是否有机会、组合是什么、为什么） */
  narrative: { zh: string; en: string };
  /** 大白话收益表：不同投入下每 8h/天/周 的规模 */
  payouts: Payout[];
  /** 费率维持不变时回本所需小时数（覆盖往返成本） */
  breakevenHours: number | null;
}

const PAYOUT_NOTIONALS = [1000, 5000, 10000, 20000];

function buildPayouts(hourlyFundingPct: number, totalCostPct: number): Payout[] {
  return PAYOUT_NOTIONALS.map((n) => {
    const perHour = (n * hourlyFundingPct) / 100;
    const oneTime = (n * totalCostPct) / 100;
    return {
      notionalUsd: n,
      fundingPer8hUsd: perHour * 8,
      fundingPerDayUsd: perHour * 24,
      fundingPerWeekUsd: perHour * 168,
      oneTimeCostUsd: oneTime,
      netPerDayUsd: perHour * 24 - oneTime,
      netPerWeekUsd: perHour * 168 - oneTime,
    };
  });
}

function buildNarrative(
  asset: string,
  hourlyPct: number,
  grossApr: number,
  netApr: number,
  coverage: number,
  codes: string[],
  spotMarket: string,
  breakevenHours: number | null,
  isWrapper: boolean,
): { zh: string; en: string } {
  const rate = `${hourlyPct.toFixed(5)}%/h（年化约 ${grossApr.toFixed(1)}%）`;
  const combo = `买入 ${spotMarket} 现货 + 做空等值 ${asset} 永续，价格涨跌对冲，专收资金费`;
  if (codes.includes('REJECTED_MAPPING'))
    return {
      zh: `${asset} 在 Hyperliquid 没有现货市场，无法构建「现货多+永续空」的对冲腿，暂不具备站内套利条件。`,
      en: `${asset} has no spot market on Hyperliquid, so the hedged spot+perp combo cannot be built.`,
    };
  if (codes.includes('REJECTED_UNSUPPORTED'))
    return {
      zh: `${asset} 当前资金费率为负（${rate}），意味着做空方要付费。反向组合（现货空+永续多）涉及借币成本，本期不支持，暂无机会。`,
      en: `${asset} funding is negative (${rate}); the reverse combo needs borrowing, not supported yet. No opportunity now.`,
    };
  if (codes.includes('REJECTED_LIQUIDITY'))
    return {
      zh: `${asset} 费率 ${rate}，但市场深度不足（未平仓额过小），实际建仓滑点会吞掉收益，判定暂无机会。`,
      en: `${asset} rate is ${rate} but open interest is too small; slippage would eat the carry. Rejected.`,
    };
  if (codes.includes('REJECTED_COST'))
    return {
      zh: `${asset} 当前费率 ${rate}，组合为「${combo}」，但费率收入无法覆盖双腿往返成本（覆盖比 ${coverage.toFixed(2)}，门槛 2.0）——这就是"毛APR幻觉"：看着有收益，扣完成本是亏的。等费率异常升高时再出手。`,
      en: `${asset} funding ${rate}: income cannot cover round-trip costs (coverage ${coverage.toFixed(2)} < 2.0). Gross APR is an illusion here; wait for a funding spike.`,
    };
  return {
    zh: `✅ ${asset} 当前费率 ${rate}，处于偏高水平，存在套利机会。组合：${combo}${isWrapper ? '（现货为包装资产，留意脱锚风险）' : ''}。扣除全部成本后建模净年化约 ${netApr.toFixed(1)}%，成本覆盖比 ${coverage.toFixed(2)}${breakevenHours ? `，费率若维持约 ${breakevenHours.toFixed(0)} 小时回本` : ''}。费率每小时结算一次，翻负即退出。`,
    en: `✅ ${asset} funding ${rate} is elevated — opportunity. Combo: long spot + short equal perp${isWrapper ? ' (wrapped spot asset)' : ''}. Modeled net APR ≈ ${netApr.toFixed(1)}%, coverage ${coverage.toFixed(2)}${breakevenHours ? `, breakeven ≈ ${breakevenHours.toFixed(0)}h if rate holds` : ''}.`,
  };
}

const HOURS_PER_YEAR = 24 * 365;
const pct = (x: number) => x * 100;

function buildCosts(venueA: string, venueB: string, grossFundingPct: number): CostItem[] {
  const feeA = CONFIG.takerFeePct[venueA] ?? 0.05;
  const feeB = CONFIG.takerFeePct[venueB] ?? 0.05;
  return [
    { label: `开+平仓手续费 · 腿1 (${venueA})`, pct: feeA * 2 },
    { label: `开+平仓手续费 · 腿2 (${venueB})`, pct: feeB * 2 },
    { label: '滑点准备金（双腿）', pct: CONFIG.slippageReservePct },
    { label: '不确定性准备金（25% × 预期funding）', pct: Math.max(0, grossFundingPct * CONFIG.uncertaintyReserveRatio) },
  ];
}

function decide(candidate: Omit<Candidate, 'decision' | 'rejectionCodes'>, extraCodes: string[]): Candidate {
  const codes = [...extraCodes];
  if (candidate.netHorizonPct <= 0 && !codes.length) codes.push('REJECTED_COST');
  if (candidate.costCoverage < CONFIG.minCostCoverage && !codes.includes('REJECTED_COST')) codes.push('REJECTED_COST');
  return { ...candidate, decision: codes.length ? 'REJECTED' : 'ACCEPTED', rejectionCodes: codes };
}

/**
 * S1：HL 站内现货多 + 永续空，收正 funding（第一版产品主线，不做跨所）。
 * universe 动态发现：HL 上所有「现货(USDC对) + 永续」同时存在的币；核心三币始终展示。
 */
export function buildS1Candidates(hlPerps: HlPerpSnapshot[], hlSpots: HlSpotSnapshot[], observedAt: string): Candidate[] {
  const out: Candidate[] = [];
  const spotByBase = new Map(hlSpots.map((s) => [s.baseToken, s]));
  const assets = new Set<string>(CONFIG.universe);
  for (const perp of hlPerps) {
    if (spotByBase.has(perp.coin) || spotByBase.has(CONFIG.wrapperMap[perp.coin] ?? '')) assets.add(perp.coin);
  }
  for (const asset of assets) {
    const perp = hlPerps.find((p) => p.coin === asset);
    if (!perp) continue;
    const wrapperToken = CONFIG.wrapperMap[asset];
    const spot = spotByBase.get(asset) ?? (wrapperToken ? spotByBase.get(wrapperToken) : undefined);
    const extraCodes: string[] = [];
    const flags: string[] = [];
    if (spot && spot.baseToken !== asset) flags.push('wrapper_risk');

    if (!spot) extraCodes.push('REJECTED_MAPPING');
    if (perp.hourlyFunding <= 0) extraCodes.push('REJECTED_UNSUPPORTED'); // 负funding现货空头不在P0
    if (perp.openInterest * perp.markPx < CONFIG.minOpenInterestUsd) extraCodes.push('REJECTED_LIQUIDITY');

    const grossFundingPct = pct(Math.max(0, perp.hourlyFunding)) * CONFIG.horizonHours;
    const costs = buildCosts('hyperliquid', 'hyperliquid', grossFundingPct);
    const totalCostPct = costs.reduce((a, c) => a + c.pct, 0);
    const netHorizonPct = grossFundingPct - totalCostPct;
    const hourlyPct = pct(perp.hourlyFunding);
    const grossAprPct = pct(perp.hourlyFunding * HOURS_PER_YEAR);
    const netAprPct = (netHorizonPct / 100 / CONFIG.horizonHours) * HOURS_PER_YEAR * 100;
    const coverage = totalCostPct > 0 ? grossFundingPct / totalCostPct : 0;
    const breakevenHours = perp.hourlyFunding > 0 ? totalCostPct / hourlyPct : null;
    const spotName = spot ? spot.pair : `${wrapperToken ?? asset}/USDC`;

    out.push(
      decide(
        {
          id: `S1-${asset}`,
          strategy: 'S1_SPOT_PERP',
          asset,
          legs: [
            { venue: 'hyperliquid', market: spot ? spot.pair : `${wrapperToken ?? asset}/USDC (未上市)`, instrument: 'spot', side: 'long', price: spot?.midPx ?? null, hourlyFundingPct: null, note: flags.includes('wrapper_risk') ? '包装资产' : undefined },
            { venue: 'hyperliquid', market: `${asset}-PERP`, instrument: 'perp', side: 'short', price: perp.markPx, hourlyFundingPct: pct(perp.hourlyFunding) },
          ],
          horizonHours: CONFIG.horizonHours,
          grossApr: grossAprPct,
          grossFundingPct,
          costs,
          totalCostPct,
          netHorizonPct,
          netApr: netAprPct,
          costCoverage: coverage,
          flags,
          observedAt,
          payouts: buildPayouts(hourlyPct, totalCostPct),
          breakevenHours,
          narrative: { zh: '', en: '' },
        },
        extraCodes,
      ),
    );
    const c = out[out.length - 1]!;
    c.narrative = buildNarrative(asset, hourlyPct, grossAprPct, netAprPct, coverage, c.rejectionCodes, spotName, breakevenHours, flags.includes('wrapper_risk'));
  }
  return out.sort((a, b) => (a.decision === b.decision ? b.netApr - a.netApr : a.decision === 'ACCEPTED' ? -1 : 1));
}

interface VenueRate {
  venue: string;
  market: string;
  hourly: number;
  price: number | null;
}

/** S2：跨平台永续-永续。做空标准化后高费率 venue、做多低费率 venue。 */
export function buildS2Candidates(
  hlPerps: HlPerpSnapshot[],
  predicted: HlPredictedFunding[],
  injPerps: InjPerpSnapshot[],
  observedAt: string,
): Candidate[] {
  const out: Candidate[] = [];
  for (const asset of CONFIG.universe) {
    const rates: VenueRate[] = [];
    const hl = hlPerps.find((p) => p.coin === asset);
    if (hl) rates.push({ venue: 'hyperliquid', market: `${asset}-PERP`, hourly: hl.hourlyFunding, price: hl.markPx });

    const pred = predicted.find((p) => p.coin === asset);
    for (const [venue, d] of Object.entries(pred?.venues ?? {})) {
      if (venue === 'HlPerp') continue; // HL 已用实时值
      const intervalH = d.fundingIntervalHours ?? 8;
      rates.push({ venue, market: `${asset}-PERP`, hourly: d.fundingRate / intervalH, price: null });
    }
    const inj = injPerps.find((i) => i.base === asset);
    if (inj && inj.estHourlyFunding !== null)
      rates.push({ venue: 'injective', market: inj.ticker, hourly: inj.estHourlyFunding, price: inj.markPrice });

    if (rates.length < 2) continue;
    // 每资产取费率差最大的一对 + 必含 Injective 的一对（PRD INJ-02 证据门）
    const sorted = [...rates].sort((a, b) => a.hourly - b.hourly);
    const pairs: [VenueRate, VenueRate][] = [[sorted[0]!, sorted[sorted.length - 1]!]];
    const injRate = rates.find((r) => r.venue === 'injective');
    if (injRate && !pairs[0]!.includes(injRate)) {
      const others = rates.filter((r) => r.venue !== 'injective');
      const best = others.reduce((a, b) => (Math.abs(b.hourly - injRate.hourly) > Math.abs(a.hourly - injRate.hourly) ? b : a));
      pairs.push(injRate.hourly < best.hourly ? [injRate, best] : [best, injRate]);
    }

    for (const [low, high] of pairs) {
      const spreadHourly = high.hourly - low.hourly;
      const extraCodes: string[] = [];
      const flags: string[] = [];
      if (high.venue === 'injective' || low.venue === 'injective') flags.push('injective_leg', 'inj_rate_estimated');
      if (hl && hl.openInterest * hl.markPx < CONFIG.minOpenInterestUsd) extraCodes.push('REJECTED_LIQUIDITY');

      const grossFundingPct = pct(Math.max(0, spreadHourly)) * CONFIG.horizonHours;
      const costs = buildCosts(high.venue, low.venue, grossFundingPct);
      const totalCostPct = costs.reduce((a, c) => a + c.pct, 0);
      const netHorizonPct = grossFundingPct - totalCostPct;

      out.push(
        decide(
          {
            id: `S2-${asset}-${high.venue}-${low.venue}`,
            strategy: 'S2_PERP_PERP',
            asset,
            legs: [
              { venue: high.venue, market: high.market, instrument: 'perp', side: 'short', price: high.price, hourlyFundingPct: pct(high.hourly), note: '收funding腿' },
              { venue: low.venue, market: low.market, instrument: 'perp', side: 'long', price: low.price, hourlyFundingPct: pct(low.hourly), note: '对冲腿' },
            ],
            horizonHours: CONFIG.horizonHours,
            grossApr: pct(spreadHourly * HOURS_PER_YEAR),
            grossFundingPct,
            costs,
            totalCostPct,
            netHorizonPct,
            netApr: (netHorizonPct / 100 / CONFIG.horizonHours) * HOURS_PER_YEAR * 100,
            costCoverage: totalCostPct > 0 ? grossFundingPct / totalCostPct : 0,
            flags,
            observedAt,
            payouts: buildPayouts(pct(Math.max(0, spreadHourly)), totalCostPct),
            breakevenHours: spreadHourly > 0 ? totalCostPct / pct(spreadHourly) : null,
            narrative: { zh: '跨所策略（本期未启用）', en: 'Cross-venue (disabled this phase)' },
          },
          extraCodes,
        ),
      );
    }
  }
  return out.sort((a, b) => b.netApr - a.netApr);
}
