import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export type Mode = 'RUNNING' | 'SAFE';

const DATA_DIR = 'data';
const KILL_FILE = `${DATA_DIR}/KILL`;
const HEARTBEAT_FILE = `${DATA_DIR}/heartbeat`;

/**
 * Tick 型监督循环：
 * - 每 tick 硬超时，绝不阻塞下一轮
 * - 连续失败 N 次 → SAFE 模式（停开仓，只观察/平仓）
 * - data/KILL 文件存在 → 立即 SAFE（人工 kill switch）
 * - 每 tick 写心跳文件，供外部 watchdog 检测
 */
export class Supervisor {
  private consecutiveFailures = 0;
  private mode: Mode = 'RUNNING';
  private stopped = false;

  constructor(private readonly tickFn: (mode: Mode) => Promise<void>) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  get currentMode(): Mode {
    return this.mode;
  }

  async runOnce(): Promise<void> {
    this.checkKillSwitch();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`tick timeout after ${config.tickTimeoutMs}ms`)), config.tickTimeoutMs),
    );
    try {
      await Promise.race([this.tickFn(this.mode), timeout]);
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      log.error('tick_failed', { error: String(err), consecutiveFailures: this.consecutiveFailures });
      if (this.consecutiveFailures >= config.maxConsecutiveFailures && this.mode !== 'SAFE') {
        this.enterSafeMode(`consecutive failures >= ${config.maxConsecutiveFailures}`);
      }
    } finally {
      writeFileSync(HEARTBEAT_FILE, String(Date.now()));
    }
  }

  async runForever(): Promise<void> {
    log.info('supervisor_start', { network: config.network, tickIntervalMs: config.tickIntervalMs });
    if (config.network === 'mainnet') log.warn('mainnet_mode', { note: 'live network — executor must respect RiskGuard' });
    process.on('SIGINT', () => (this.stopped = true));
    process.on('SIGTERM', () => (this.stopped = true));
    while (!this.stopped) {
      const started = Date.now();
      await this.runOnce();
      const elapsed = Date.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(0, config.tickIntervalMs - elapsed)));
    }
    log.info('supervisor_stopped');
  }

  private checkKillSwitch(): void {
    if (existsSync(KILL_FILE) && this.mode !== 'SAFE') this.enterSafeMode('KILL file present');
  }

  private enterSafeMode(reason: string): void {
    this.mode = 'SAFE';
    log.error('enter_safe_mode', { reason });
    // 执行层接入后：在此撤全部挂单、禁止 open、仅允许 close/reconcile
  }
}
