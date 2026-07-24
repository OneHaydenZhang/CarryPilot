import { config } from './config.js';
import { log } from './lib/logger.js';
import { fetchPerpSnapshots, fetchPredictedFundings } from './connectors/hyperliquid.js';
import { fetchInjPerpSnapshots } from './connectors/injective.js';
import { scanHlCarry, scanHlInjFundingSpread } from './core/scanner.js';
import { Supervisor, type Mode } from './core/supervisor.js';

async function tick(mode: Mode): Promise<void> {
  // 单数据源失败 → 降级为可用数据源的扫描，不让整个 tick 失败
  const [hlResult, injResult] = await Promise.allSettled([fetchPerpSnapshots(), fetchInjPerpSnapshots()]);
  if (hlResult.status === 'rejected') log.warn('hl_fetch_failed', { error: String(hlResult.reason) });
  if (injResult.status === 'rejected') log.warn('inj_fetch_failed', { error: String(injResult.reason) });
  if (hlResult.status === 'rejected' && injResult.status === 'rejected') throw new Error('all data sources failed');
  const hlSnapshots = hlResult.status === 'fulfilled' ? hlResult.value : [];
  const injSnapshots = injResult.status === 'fulfilled' ? injResult.value : [];
  log.info('data_collected', { hlPerps: hlSnapshots.length, injPerps: injSnapshots.length });

  const carry = scanHlCarry(hlSnapshots);
  const spread = scanHlInjFundingSpread(hlSnapshots, injSnapshots);

  for (const o of [...carry.slice(0, 5), ...spread.slice(0, 5)]) {
    log.info('opportunity', {
      kind: o.kind,
      symbol: o.symbol,
      grossApr: `${(o.grossApr * 100).toFixed(2)}%`,
      netApr7d: `${(o.netApr7d * 100).toFixed(2)}%`,
      ...o.detail,
    });
  }
  if (carry.length + spread.length === 0) log.info('no_opportunity_above_threshold');

  // L3(LLM 决策) 与执行层在 PRD 后接入：
  // mode === 'RUNNING' 时才允许产生 open 决策；SAFE 模式只允许 close。
  void mode;
}

const once = process.argv.includes('--once');
const supervisor = new Supervisor(tick);
log.info('boot', { network: config.network, once });
if (once) await supervisor.runOnce();
else await supervisor.runForever();
