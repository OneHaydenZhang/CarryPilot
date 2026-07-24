import type { HlPerpSnapshot } from '../connectors/hyperliquid.js';
import type { InjPerpSnapshot } from '../connectors/injective.js';

/** 双边进出成本估算（taker 双腿开+平，比例）。实盘接入后改为从 userFees 实时读取。 */
const ROUND_TRIP_COST = 0.0045 * 0.01 * 4; // 0.045% taker × 4 腿 ≈ 0.18%

export interface Opportunity {
  kind: 'hl-carry' | 'hl-inj-funding-spread';
  symbol: string;
  /** 年化毛收益（比例） */
  grossApr: number;
  /** 扣除进出成本摊销后的参考年化（按 7 天持有期摊销） */
  netApr7d: number;
  detail: Record<string, unknown>;
}

const HOURS_PER_YEAR = 24 * 365;
const amortized = (grossApr: number) => grossApr - ROUND_TRIP_COST * (365 / 7);

/** 模式A信号：HL 站内 funding carry（现货多+永续空收正费率；负费率则反向仅在有对应借贷/库存时可行，先只报正） */
export function scanHlCarry(hl: HlPerpSnapshot[], minNetApr = 0.05): Opportunity[] {
  return hl
    .filter((s) => s.hourlyFunding > 0 && s.openInterest * s.markPx > 1_000_000)
    .map((s) => {
      const grossApr = s.hourlyFunding * HOURS_PER_YEAR;
      return {
        kind: 'hl-carry' as const,
        symbol: s.coin,
        grossApr,
        netApr7d: amortized(grossApr),
        detail: { hourlyFunding: s.hourlyFunding, markPx: s.markPx, oiUsd: Math.round(s.openInterest * s.markPx) },
      };
    })
    .filter((o) => o.netApr7d > minNetApr)
    .sort((a, b) => b.netApr7d - a.netApr7d);
}

/** 模式B信号：HL ↔ INJ 同标的费率差（两腿 perp 反向） */
export function scanHlInjFundingSpread(hl: HlPerpSnapshot[], inj: InjPerpSnapshot[], minNetApr = 0.05): Opportunity[] {
  const hlByCoin = new Map(hl.map((s) => [s.coin, s]));
  const out: Opportunity[] = [];
  for (const i of inj) {
    const h = hlByCoin.get(i.base);
    if (!h || i.estHourlyFunding === null) continue;
    const injHourly = i.estHourlyFunding;
    const spreadHourly = h.hourlyFunding - injHourly; // >0: HL空/INJ多收差值
    const grossApr = Math.abs(spreadHourly) * HOURS_PER_YEAR;
    const netApr7d = amortized(grossApr);
    if (netApr7d <= minNetApr) continue;
    out.push({
      kind: 'hl-inj-funding-spread',
      symbol: i.base,
      grossApr,
      netApr7d,
      detail: {
        hlHourly: h.hourlyFunding,
        injHourly,
        direction: spreadHourly > 0 ? 'short-HL / long-INJ' : 'long-HL / short-INJ',
        injTicker: i.ticker,
      },
    });
  }
  return out.sort((a, b) => b.netApr7d - a.netApr7d);
}
