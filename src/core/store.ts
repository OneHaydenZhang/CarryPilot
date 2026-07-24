import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

/** 单进程 JSON 状态存储（原子写）。v1 迁移 SQLite/Postgres 前的最小持久化。 */

export interface AgentLogEntry {
  at: string;
  msg: string;
}

export interface AgentRecord {
  id: string;
  owner: string; // 钱包地址（lowercase）
  name: string;
  asset: 'ALL' | string;
  style: 'conservative' | 'balanced' | 'aggressive';
  capitalUsd: number;
  mode: 'PAPER' | 'LIVE';
  status: 'RUNNING' | 'STOPPED';
  createdAt: string;
  log: AgentLogEntry[];
  /** 收益曲线快照（引擎每 tick 追加，稀释保留） */
  equitySeries: { at: string; pnlUsd: number }[];
  /** 回合制：每 tick 消耗一回合，用尽自动停止（上限 120） */
  maxRounds: number;
  rounds: number;
  /** 用户自定义的 LLM 评估补充指令 */
  customPrompt: string;
  /** Agent 记忆：每笔平仓后的复盘，喂给后续 LLM 评估形成学习闭环 */
  memory?: { at: string; asset: string; pnlUsd: number; holdHours: number; entryNetApr: number; realizedApr: number; lesson: string }[];
}

export interface PositionRecord {
  id: string;
  agentId: string | null; // null = 实盘手动仓
  owner: string;
  mode: 'PAPER' | 'LIVE';
  asset: string;
  spotMarket: string;
  perpMarket: string;
  notionalUsd: number;
  entryAt: string;
  entryHourlyFundingPct: number;
  entryNetApr: number;
  currentHourlyFundingPct: number;
  fundingAccruedUsd: number;
  costsPaidUsd: number;
  pnlUsd: number;
  status: 'OPEN' | 'CLOSED';
  lastTickAt: string;
  closedAt?: string;
  closeReason?: string;
  receiptHash?: string;
  /** LIVE 仓的真实成交回执 */
  fills?: unknown[];
  /** 每 tick 快照：实际 PnL vs 入场时点的预测 PnL（前端画预测/实际对比图） */
  series?: { at: string; pnlUsd: number; predictedPnlUsd: number }[];
}

export interface UserWalletRecord {
  owner: string;
  agentAddress: string;
  agentPrivateKey: string; // 仅存服务器 data/（0600, gitignored）；HL API wallet 无提币权限
  approvedAt: string | null;
}

export interface UserPrefsRecord {
  owner: string;
  /** 虚拟盘账户资金（用户在设置里自定，虚拟盘 Agent 从中划拨） */
  virtualBalanceUsd: number;
}

export interface PointsTxRecord {
  address: string;
  kind: string; // welcome | deposit | tick | grant
  points: number;
  txhash: string;
  note: string;
  at: string;
}

interface StoreShape {
  agents: AgentRecord[];
  positions: PositionRecord[];
  wallets: UserWalletRecord[];
  points: Record<string, number>;
  pointsTx: PointsTxRecord[];
  prefs: UserPrefsRecord[];
}

const FILE = 'data/store.json';
const empty = (): StoreShape => ({ agents: [], positions: [], wallets: [], points: {}, pointsTx: [], prefs: [] });
let state: StoreShape = empty();

export function loadStore(): void {
  try {
    state = { ...empty(), ...(JSON.parse(readFileSync(FILE, 'utf8')) as StoreShape) };
  } catch {
    state = empty();
  }
}

export function saveStore(): void {
  mkdirSync('data', { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
}

export const store = {
  get agents() {
    return state.agents;
  },
  get positions() {
    return state.positions;
  },
  get wallets() {
    return state.wallets;
  },
  get points() {
    return state.points;
  },
  get pointsTx() {
    return state.pointsTx;
  },
  get prefs() {
    return state.prefs;
  },
};

const DEFAULT_VIRTUAL_BALANCE = 10_000;
export function virtualBalanceOf(owner: string): number {
  return state.prefs.find((p) => p.owner === owner)?.virtualBalanceUsd ?? DEFAULT_VIRTUAL_BALANCE;
}
export function setVirtualBalance(owner: string, usd: number): void {
  const clamped = Math.min(Math.max(usd, 100), 1_000_000);
  const rec = state.prefs.find((p) => p.owner === owner);
  if (rec) rec.virtualBalanceUsd = clamped;
  else state.prefs.push({ owner, virtualBalanceUsd: clamped });
}
