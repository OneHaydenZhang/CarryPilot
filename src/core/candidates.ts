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
          grossApr: pct(perp.hourlyFunding * HOURS_PER_YEAR),
          grossFundingPct,
          costs,
          totalCostPct,
          netHorizonPct,
          netApr: (netHorizonPct / 100 / CONFIG.horizonHours) * HOURS_PER_YEAR * 100,
          costCoverage: totalCostPct > 0 ? grossFundingPct / totalCostPct : 0,
          flags,
          observedAt,
        },
        extraCodes,
      ),
    );
  }
  return out;
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
          },
          extraCodes,
        ),
      );
    }
  }
  return out.sort((a, b) => b.netApr - a.netApr);
}
