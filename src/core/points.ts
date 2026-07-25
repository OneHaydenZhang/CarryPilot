import { store, saveStore } from './store.js';
import { config } from '../config.js';
import { ethToInj, injToEth } from '../lib/bech32.js';
import { log } from '../lib/logger.js';

/**
 * INJ 积分（platform credits）— 参考 Manek INJ AI 的机制移植：
 * 用户向平台金库地址转原生 INJ → 链上扫描入账（按 sender 归属、txhash 幂等）→
 * 1 INJ = POINTS_RATE 积分；Agent 每个决策 tick 扣 POINTS_PER_TICK。
 * 归属：登录用 EVM 0x 地址，其 Injective 原生地址 = bech32(同一字节) → 无需映射表，
 * 只要用户从自己登录的钱包转账即可精确归属。金库余额永不对外暴露。
 */

export const POINTS = {
  treasury: process.env.INJ_TREASURY_ADDRESS ?? '', // inj1... 或 0x...
  rateInj: Number(process.env.POINTS_RATE_INJ ?? 100),
  perTick: Number(process.env.POINTS_PER_TICK ?? 0.2),
  welcomeGrant: Number(process.env.POINTS_WELCOME ?? 500),
} as const;

export function treasuryInj(): string {
  const t = POINTS.treasury;
  if (!t) return '';
  return t.startsWith('0x') ? ethToInj(t) : t;
}
/** 金库对应的 EVM 0x 地址（用于 Injective EVM 原生转账；仅用于构造交易，不在 UI 展示） */
export function treasuryEvm(): string {
  const t = POINTS.treasury;
  if (!t) return '';
  return t.startsWith('0x') ? t.toLowerCase() : injToEth(t);
}
/** 充值套餐（积分档位），对齐 Manek */
export const POINT_PRESETS = (process.env.POINTS_PRESETS ?? '1,5,10,100,200,1000').split(',').map(Number).filter((n) => n > 0);

/** 广播成功后直接入积分（幂等：txhash 去重） */
export function creditDeposit(owner: string, injAmount: number, txHash: string): { credited: boolean; points: number } {
  if (txHash && store.pointsTx.some((t) => t.txhash === txHash)) return { credited: false, points: 0 };
  const pts = injAmount * POINTS.rateInj;
  credit(owner, pts, 'deposit', { txhash: txHash, note: `deposit ${injAmount.toFixed(6)} INJ → ${pts.toFixed(0)} 积分` });
  saveStore();
  return { credited: true, points: pts };
}

export function balanceOf(address: string): number {
  return store.points[address.toLowerCase()] ?? 0;
}

function apply(address: string, delta: number, kind: string, extra: Partial<(typeof store.pointsTx)[number]> = {}): boolean {
  const addr = address.toLowerCase();
  const cur = store.points[addr] ?? 0;
  const next = cur + delta;
  if (next < -1e-9) return false;
  store.points[addr] = Math.max(0, Number(next.toFixed(6)));
  store.pointsTx.push({ address: addr, kind, points: delta, txhash: '', note: '', at: new Date().toISOString(), ...extra });
  if (store.pointsTx.length > 5000) store.pointsTx.splice(0, store.pointsTx.length - 5000);
  return true;
}

export function credit(address: string, points: number, kind: string, extra?: Partial<(typeof store.pointsTx)[number]>): void {
  if (points > 0) apply(address, points, kind, extra);
}
export function tryDebit(address: string, points: number, kind: string, note = ''): boolean {
  return apply(address, -Math.abs(points), kind, { note });
}

export function grantWelcomeIfNew(address: string): void {
  const addr = address.toLowerCase();
  if (store.pointsTx.some((t) => t.address === addr)) return;
  credit(addr, POINTS.welcomeGrant, 'welcome', { note: `新用户赠送 ${POINTS.welcomeGrant} 积分` });
  saveStore();
}

const seenTx = (txhash: string) => store.pointsTx.some((t) => t.txhash === txhash);

interface LcdTxsResponse {
  tx_responses?: { txhash: string; code: number; events?: { type: string; attributes: { key: string; value: string }[] }[] }[];
}

const deb64 = (s: string) => (/^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0 && !s.startsWith('inj') && !/^\d/.test(s) ? Buffer.from(s, 'base64').toString() : s);

/** 扫描金库最近入账，只给「当前用户自己转入」的交易入账（幂等） */
export async function scanDepositsFor(owner: string): Promise<{ credited: number; creditedPoints: number; error?: string }> {
  const treasury = treasuryInj();
  if (!treasury) return { credited: 0, creditedPoints: 0, error: '未配置金库地址' };
  const senderInj = ethToInj(owner);
  const queries = [
    `query=${encodeURIComponent(`coin_received.receiver='${treasury}'`)}`,
    `events=${encodeURIComponent(`coin_received.receiver='${treasury}'`)}`,
  ];
  let txs: NonNullable<LcdTxsResponse['tx_responses']> = [];
  let lastErr = '';
  for (const q of queries) {
    try {
      const res = await fetch(`${config.inj.lcd}/cosmos/tx/v1beta1/txs?${q}&order_by=ORDER_BY_DESC&limit=30`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        lastErr = `LCD ${res.status}`;
        continue;
      }
      const data = (await res.json()) as LcdTxsResponse;
      txs = data.tx_responses ?? [];
      break;
    } catch (err) {
      lastErr = String(err).slice(0, 100);
    }
  }
  if (!txs.length && lastErr) return { credited: 0, creditedPoints: 0, error: lastErr };

  let credited = 0;
  let creditedPoints = 0;
  for (const tx of txs) {
    if (tx.code !== 0 || seenTx(tx.txhash)) continue;
    // 找 coin_received(receiver=treasury) 的金额，以及对应 coin_spent(spender=sender)
    let amountInj = 0;
    let spender = '';
    for (const ev of tx.events ?? []) {
      const attrs = Object.fromEntries((ev.attributes ?? []).map((a) => [deb64(a.key), deb64(a.value)]));
      if (ev.type === 'coin_received' && attrs.receiver === treasury && attrs.amount?.endsWith('inj'))
        amountInj += Number(attrs.amount.slice(0, -3)) / 1e18;
      if (ev.type === 'coin_spent' && attrs.spender && attrs.amount?.endsWith('inj')) spender = attrs.spender;
    }
    if (amountInj <= 0) continue;
    if (spender !== senderInj) continue; // 只认当前用户自己的转账，杜绝错归属
    const pts = amountInj * POINTS.rateInj;
    credit(owner, pts, 'deposit', { txhash: tx.txhash, note: `deposit ${amountInj.toFixed(6)} INJ → ${pts.toFixed(0)} 积分` });
    credited++;
    creditedPoints += pts;
    log.info('points_deposit_credited', { owner, txhash: tx.txhash, amountInj, pts });
  }
  if (credited) saveStore();
  return { credited, creditedPoints };
}

export function historyOf(address: string, limit = 30) {
  const addr = address.toLowerCase();
  return store.pointsTx.filter((t) => t.address === addr).slice(-limit).reverse();
}
