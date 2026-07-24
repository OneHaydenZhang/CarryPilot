import { config } from '../config.js';
import { postJson } from '../lib/http.js';

export interface HlPerpSnapshot {
  coin: string;
  /** 当前小时资金费率（比例，如 0.0000125 = 0.00125%/h） */
  hourlyFunding: number;
  markPx: number;
  oraclePx: number;
  openInterest: number;
  maxLeverage: number;
}

export interface HlPredictedFunding {
  coin: string;
  /** venue -> 下一期费率（各所口径不同：HL 为小时费率，CEX 多为 8h 费率） */
  venues: Record<string, { fundingRate: number; nextFundingTime: number; fundingIntervalHours?: number }>;
}

interface MetaAndAssetCtxsResponse {
  0: { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] };
  1: { funding: string; markPx: string; oraclePx: string; openInterest: string }[];
}

const infoUrl = () => `${config.hl.api}/info`;

/** 全市场永续快照：当前资金费率、标记价、OI（免签名） */
export async function fetchPerpSnapshots(): Promise<HlPerpSnapshot[]> {
  const [meta, ctxs] = await postJson<MetaAndAssetCtxsResponse>(infoUrl(), { type: 'metaAndAssetCtxs' }) as unknown as [
    MetaAndAssetCtxsResponse[0],
    MetaAndAssetCtxsResponse[1],
  ];
  return meta.universe
    .map((u, i) => {
      const ctx = ctxs[i];
      if (!ctx || u.isDelisted) return null;
      return {
        coin: u.name,
        hourlyFunding: Number(ctx.funding),
        markPx: Number(ctx.markPx),
        oraclePx: Number(ctx.oraclePx),
        openInterest: Number(ctx.openInterest),
        maxLeverage: u.maxLeverage,
      };
    })
    .filter((s): s is HlPerpSnapshot => s !== null && Number.isFinite(s.hourlyFunding));
}

export interface HlSpotSnapshot {
  pair: string;
  baseToken: string;
  midPx: number;
  dayNotionalVolume: number;
}

interface SpotMetaAndAssetCtxsResponse {
  0: { tokens: { name: string; index: number }[]; universe: { name: string; tokens: [number, number]; index: number }[] };
  1: { midPx: string | null; dayNtlVlm: string; markPx: string | null }[];
}

/** 现货市场快照（S1 现货腿用；HL 现货 BTC/ETH/SOL 为包装资产 UBTC/UETH/USOL） */
export async function fetchSpotSnapshots(): Promise<HlSpotSnapshot[]> {
  const [meta, ctxs] = (await postJson<SpotMetaAndAssetCtxsResponse>(infoUrl(), { type: 'spotMetaAndAssetCtxs' })) as unknown as [
    SpotMetaAndAssetCtxsResponse[0],
    SpotMetaAndAssetCtxsResponse[1],
  ];
  const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
  return meta.universe
    .map((u) => {
      const ctx = ctxs[u.index];
      const base = tokenName.get(u.tokens[0]);
      const quote = tokenName.get(u.tokens[1]);
      if (!ctx?.midPx || !base || quote !== 'USDC') return null;
      return { pair: `${base}/USDC`, baseToken: base, midPx: Number(ctx.midPx), dayNotionalVolume: Number(ctx.dayNtlVlm) };
    })
    .filter((s): s is HlSpotSnapshot => s !== null);
}

type PredictedFundingsResponse = [string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null][]][];

/** 官方聚合的多所预测费率（HL/Binance/Bybit 等），跨所费率差策略的数据源 */
export async function fetchPredictedFundings(): Promise<HlPredictedFunding[]> {
  const raw = await postJson<PredictedFundingsResponse>(infoUrl(), { type: 'predictedFundings' });
  return raw.map(([coin, venues]) => ({
    coin,
    venues: Object.fromEntries(
      venues
        .filter((v): v is [string, NonNullable<(typeof venues)[number][1]>] => v[1] !== null)
        .map(([venue, d]) => [
          venue,
          { fundingRate: Number(d.fundingRate), nextFundingTime: d.nextFundingTime, fundingIntervalHours: d.fundingIntervalHours },
        ]),
    ),
  }));
}
