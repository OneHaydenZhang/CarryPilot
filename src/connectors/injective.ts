import { config } from '../config.js';

export interface InjPerpSnapshot {
  marketId: string;
  ticker: string;
  /** 从 ticker 提取的基础资产符号，用于与 HL coin 对齐（如 BTC） */
  base: string;
  /** 当前资金周期的小时费率估计（interest + 周期内已累计 premium 均值，未 clamp） */
  estHourlyFunding: number | null;
  fundingIntervalSeconds: number;
  markPrice: number;
  makerFeeRate: number;
  takerFeeRate: number;
}

interface LcdDerivativeMarketsResponse {
  markets: {
    market: {
      ticker: string;
      market_id: string;
      isPerpetual: boolean;
      maker_fee_rate: string;
      taker_fee_rate: string;
      oracle_scale_factor: number;
      quote_decimals: number;
    };
    perpetual_info?: {
      market_info: { hourly_interest_rate: string; hourly_funding_rate_cap: string; next_funding_timestamp: string; funding_interval: string };
      funding_info: { cumulative_funding: string; cumulative_price: string; last_timestamp: string };
    };
    mark_price: string;
  }[];
}

/**
 * 经链上 LCD（Cosmos REST）读取 exchange module 状态。
 * 注意：Injective Labs 官方 sentry.* 与 indexer 端点存在地域封锁（中国网络 403），
 * 因此默认走社区端点（publicnode）；生产部署在海外服务器时可切回官方端点（env INJ_LCD_URL）。
 */
export async function fetchInjPerpSnapshots(): Promise<InjPerpSnapshot[]> {
  const res = await fetch(`${config.inj.lcd}/injective/exchange/v1beta1/derivative/markets?status=Active`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`INJ LCD HTTP ${res.status}`);
  const data = (await res.json()) as LcdDerivativeMarketsResponse;
  const nowSec = Date.now() / 1000;

  return data.markets
    .filter((m) => m.market.isPerpetual && m.perpetual_info)
    .map((m) => {
      const info = m.perpetual_info!;
      const interval = Number(info.market_info.funding_interval);
      const nextTs = Number(info.market_info.next_funding_timestamp);
      const elapsed = Math.max(1, interval - (nextTs - nowSec));
      // mark_price 为链上定点表示，需除以 10^quote_decimals 还原（不同市场 decimals 不同）
      const markPrice = Number(m.mark_price) / 10 ** m.market.quote_decimals;
      // 估算：本周期费率 ≈ hourly_interest + (周期内累计价格差/秒 × 3600) / mark_price，
      // 结算时被链上 cap 钳制。经 BTC 实测与 HL 同标的量级一致（~0.0015%/h）；
      // TODO: 待可访问官方 indexer 时，用其 fundingRates 交叉验证此换算。
      const cap = Number(info.market_info.hourly_funding_rate_cap);
      const premiumPerHour = ((Number(info.funding_info.cumulative_price) / elapsed) * 3600) / markPrice;
      const raw = Number(info.market_info.hourly_interest_rate) + premiumPerHour;
      const estHourlyFunding = Math.max(-cap, Math.min(cap, raw));
      return {
        marketId: m.market.market_id,
        ticker: m.market.ticker,
        base: m.market.ticker.split('/')[0]?.trim().toUpperCase() ?? m.market.ticker,
        estHourlyFunding: Number.isFinite(estHourlyFunding) ? estHourlyFunding : null,
        fundingIntervalSeconds: interval,
        markPrice,
        makerFeeRate: Number(m.market.maker_fee_rate),
        takerFeeRate: Number(m.market.taker_fee_rate),
      };
    });
}
