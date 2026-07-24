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
}

export interface UserWalletRecord {
  owner: string;
  agentAddress: string;
  agentPrivateKey: string; // 仅存服务器 data/（0600, gitignored）；HL API wallet 无提币权限
  approvedAt: string | null;
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
}

const FILE = 'data/store.json';
const empty = (): StoreShape => ({ agents: [], positions: [], wallets: [], points: {}, pointsTx: [] });
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
};
