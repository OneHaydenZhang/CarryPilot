import { log } from '../lib/logger.js';
import type { Candidate } from './candidates.js';

/**
 * LLM 评估层（OpenRouter）：对确定性引擎产出的 ACCEPTED 候选做「是否值得开仓」二次评估。
 * 铁律：LLM 结论只是建议 —— approve=false 可以否决开仓，但 approve=true 不能绕过 RiskGuard。
 * 未配置 OPENROUTER_API_KEY 时整层跳过（纯规则模式），系统照常运行。
 */

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat';

export const llmEnabled = (): boolean => Boolean(KEY);

export interface LlmVerdict {
  approve: boolean;
  confidence: number;
  reasoning: string;
  model: string;
  at: string;
}

const cache = new Map<string, LlmVerdict>();
let hourBudgetUsed = 0;
let hourBucket = 0;
const HOUR_BUDGET = 30;

export async function evaluateCandidate(c: Candidate): Promise<LlmVerdict | null> {
  if (!KEY) return null;
  const bucket = Math.floor(Date.now() / 3600e3);
  if (bucket !== hourBucket) {
    hourBucket = bucket;
    hourBudgetUsed = 0;
  }
  const cacheKey = `${c.asset}-${bucket}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  if (hourBudgetUsed >= HOUR_BUDGET) return null; // 预算耗尽 → 降级规则模式

  const perpLeg = c.legs.find((l) => l.instrument === 'perp');
  const prompt = `你是资金费率套利研究员。对以下 Hyperliquid 站内「现货多+永续空」候选给出是否开仓的判断。
候选数据（确定性引擎计算，不可质疑数值本身）：
- 资产: ${c.asset}，当前小时资金费率: ${perpLeg?.hourlyFundingPct?.toFixed(5)}%/h
- 毛APR: ${c.grossApr.toFixed(2)}%，扣全部成本后建模净APR: ${c.netApr.toFixed(2)}%（持有${c.horizonHours}h口径）
- 成本覆盖比: ${c.costCoverage.toFixed(2)}，标记: ${c.flags.join(',') || '无'}
评估要点：费率的可持续性（极端高费率往往几小时内衰减）、小币种费率噪声、wrapper 资产风险。
只输出 JSON: {"approve": boolean, "confidence": 0到1, "reasoning": "中文，≤120字"}`;

  try {
    hourBudgetUsed++;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`openrouter HTTP ${res.status}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0]?.message.content ?? '{}') as Partial<LlmVerdict>;
    if (typeof parsed.approve !== 'boolean') throw new Error('invalid verdict shape');
    const verdict: LlmVerdict = {
      approve: parsed.approve,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      reasoning: String(parsed.reasoning ?? '').slice(0, 200),
      model: MODEL,
      at: new Date().toISOString(),
    };
    cache.set(cacheKey, verdict);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return verdict;
  } catch (err) {
    log.warn('llm_evaluate_failed', { asset: c.asset, error: String(err).slice(0, 150) });
    return null; // LLM 失败 → 规则模式继续，不阻塞引擎
  }
}
