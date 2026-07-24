import { z } from 'zod';

/** L3 决策层（LLM/规则）产出的统一决策格式 —— LLM 输出必须通过此 schema 校验 */
export const DecisionSchema = z.object({
  action: z.enum(['open', 'close', 'hold']),
  kind: z.enum(['hl-carry', 'hl-inj-funding-spread']),
  symbol: z.string().min(1),
  notionalUsd: z.number().positive(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  ttlMs: z.number().int().positive(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface RiskVerdict {
  allowed: boolean;
  reasons: string[];
}

export interface RiskLimits {
  symbolAllowlist: Set<string>;
  maxNotionalPerSymbolUsd: number;
  maxTotalNotionalUsd: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  symbolAllowlist: new Set(['BTC', 'ETH', 'SOL', 'INJ', 'HYPE']),
  maxNotionalPerSymbolUsd: 1_000,
  maxTotalNotionalUsd: 3_000,
};

/**
 * RiskGuard：确定性硬校验，LLM 无法越权。
 * v0 为纯校验器；执行层接入后在此叠加当前持仓核算与日亏损熔断。
 */
export function evaluate(decision: Decision, limits: RiskLimits = DEFAULT_LIMITS, currentTotalNotionalUsd = 0): RiskVerdict {
  const reasons: string[] = [];
  if (!limits.symbolAllowlist.has(decision.symbol)) reasons.push(`symbol ${decision.symbol} not in allowlist`);
  if (decision.notionalUsd > limits.maxNotionalPerSymbolUsd) reasons.push(`notional ${decision.notionalUsd} > per-symbol limit ${limits.maxNotionalPerSymbolUsd}`);
  if (decision.action === 'open' && currentTotalNotionalUsd + decision.notionalUsd > limits.maxTotalNotionalUsd)
    reasons.push(`total notional would exceed ${limits.maxTotalNotionalUsd}`);
  return { allowed: reasons.length === 0, reasons };
}
