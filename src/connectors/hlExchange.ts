import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as hl from '@nktkas/hyperliquid';
import { config } from '../config.js';
import { store, saveStore, type PositionRecord, type UserWalletRecord } from '../core/store.js';
import { CONFIG } from '../core/candidates.js';
import { log } from '../lib/logger.js';

/**
 * Hyperliquid 实盘执行层。
 * 模型：用户主钱包在浏览器签 ApproveAgent（EIP-712）授权平台生成的 API wallet；
 * API wallet 只能签交易动作、无法提币；私钥仅存服务器 data/store.json（0600）。
 * 下单经 @nktkas/hyperliquid SDK（msgpack/L1 签名由 SDK 处理，不手写）。
 */

const isTestnet = config.network === 'testnet';
const transport = new hl.HttpTransport({ isTestnet });
const infoClient = new hl.InfoClient({ transport });

const AGENT_NAME_PREFIX = 'cpilot';
const LIVE_SLIPPAGE = 0.005; // 双腿 IOC 限价保护 0.5%
/**
 * HL 的 EIP-712 domain.chainId 固定绑定 Arbitrum（跟用户钱包当前连的网络无关，
 * MetaMask 对 typed data 签名不要求钱包实际处于该链）：mainnet=0xa4b1（Arbitrum One），
 * testnet=0x66eee（Arbitrum Sepolia）。用钱包自己的 chainId 会导致签名校验失败。
 * 参考 @nktkas/hyperliquid signUserSignedAction 官方示例。
 */
const HL_SIGNATURE_CHAIN_ID = isTestnet ? '0x66eee' : '0xa4b1';

export function getOrCreateAgentWallet(owner: string): UserWalletRecord {
  let w = store.wallets.find((x) => x.owner === owner);
  if (!w) {
    const pk = generatePrivateKey();
    w = { owner, agentAddress: privateKeyToAccount(pk).address.toLowerCase(), agentPrivateKey: pk, approvedAt: null };
    store.wallets.push(w);
    saveStore();
  }
  return w;
}

/** 生成给 MetaMask 的 ApproveAgent EIP-712 payload（用户主钱包签名） */
export function buildApproveAgentTypedData(owner: string) {
  const w = getOrCreateAgentWallet(owner);
  const nonce = Date.now();
  const agentName = `${AGENT_NAME_PREFIX}-${randomUUID().slice(0, 6)}`; // ≤16 字符（HL 硬限制）
  const action = {
    type: 'approveAgent',
    hyperliquidChain: isTestnet ? 'Testnet' : 'Mainnet',
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    agentAddress: w.agentAddress,
    agentName,
    nonce,
  };
  const typedData = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(HL_SIGNATURE_CHAIN_ID), verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: {
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: action.hyperliquidChain, agentAddress: w.agentAddress, agentName, nonce },
  };
  return { action, typedData, agentAddress: w.agentAddress };
}

/** 提交用户签名后的 ApproveAgent 到 HL exchange */
export async function submitApproveAgent(owner: string, action: Record<string, unknown>, signature: `0x${string}`): Promise<void> {
  const r = signature.slice(0, 66) as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);
  const res = await fetch(`${config.hl.api}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce: action.nonce, signature: { r, s, v } }),
  });
  const body = (await res.json()) as { status: string; response?: unknown };
  const w = store.wallets.find((x) => x.owner === owner)!;
  if (body.status !== 'ok') {
    // 账户没入过金时 HL 拒绝任何签名动作（含 approveAgent 本身）——这是 HL 自己的账户激活规则，不是我们的错。
    // 产品决定：授权这一步不卡用户，本地照样标记「已授权」放用户去建 Agent；真缺钱的后果留到下单那一刻由 HL
    // 按实际余额自然拒绝（liveOpenCarry 已有优雅失败+日志），到时候提示"重新授权"更准确、也更贴近用户实际状态。
    // 其他签名/网络等真正的技术性失败仍然往外抛，走 logId 那条路。
    if (typeof body.response === 'string' && /must deposit/i.test(body.response)) {
      log.warn('live_approve_needs_deposit_soft_ok', { owner, agent: w.agentAddress, hlResponse: body.response });
      w.approvedAt = new Date().toISOString();
      saveStore();
      return;
    }
    throw new Error(`approveAgent failed: ${JSON.stringify(body).slice(0, 300)}`);
  }
  w.approvedAt = new Date().toISOString();
  saveStore();
  log.info('live_agent_approved', { owner, agent: w.agentAddress });
}

function exchangeClientFor(owner: string): hl.ExchangeClient {
  const w = store.wallets.find((x) => x.owner === owner);
  if (!w?.approvedAt) throw new Error('live not enabled: agent wallet not approved');
  return new hl.ExchangeClient({ wallet: privateKeyToAccount(w.agentPrivateKey as `0x${string}`), transport });
}

interface AssetMeta {
  perpAssetId: number;
  perpSzDecimals: number;
  spotAssetId: number;
  spotSzDecimals: number;
  spotPair: string;
  spotMid: number;
  perpMid: number;
}

async function resolveAsset(asset: string): Promise<AssetMeta> {
  const [meta, spotMeta, mids] = await Promise.all([infoClient.meta(), infoClient.spotMeta(), infoClient.allMids()]);
  const perpIdx = meta.universe.findIndex((u) => u.name === asset);
  if (perpIdx < 0) throw new Error(`no perp for ${asset}`);
  const baseToken = CONFIG.wrapperMap[asset] ?? asset;
  const token = spotMeta.tokens.find((t) => t.name === baseToken);
  const usdc = spotMeta.tokens.find((t) => t.name === 'USDC');
  const pair = spotMeta.universe.find((u) => token && usdc && u.tokens[0] === token.index && u.tokens[1] === usdc.index);
  if (!token || !pair) throw new Error(`no spot pair for ${asset}`);
  const spotMid = Number(mids[pair.name] ?? mids[`${baseToken}/USDC`]);
  const perpMid = Number(mids[asset]);
  if (!spotMid || !perpMid) throw new Error(`no mid price for ${asset}`);
  return {
    perpAssetId: perpIdx,
    perpSzDecimals: meta.universe[perpIdx]!.szDecimals,
    spotAssetId: 10000 + pair.index,
    spotSzDecimals: token.szDecimals,
    spotPair: `${baseToken}/USDC`,
    spotMid,
    perpMid,
  };
}

const roundSz = (sz: number, szDecimals: number) => sz.toFixed(szDecimals);
/** HL 价格规则：≤5 有效数字（整数部分超过时按整数），限价保护价 */
function px(raw: number): string {
  const sig = Number(raw.toPrecision(5));
  return String(sig);
}

async function iocOrder(client: hl.ExchangeClient, assetId: number, isBuy: boolean, price: string, size: string, reduceOnly = false) {
  const res = await client.order({
    orders: [{ a: assetId, b: isBuy, p: price, s: size, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  });
  const status = res.response.data.statuses[0] as Record<string, unknown>;
  if ('error' in status) throw new Error(String(status.error));
  return status;
}

/** 真实开套利单：买现货 + 空永续（等名义）。先执行永续腿（流动性更好，失败代价低），再对冲现货腿。 */
export async function liveOpenCarry(owner: string, asset: string, notionalUsd: number) {
  const client = exchangeClientFor(owner);
  const m = await resolveAsset(asset);
  const perpSize = roundSz(notionalUsd / m.perpMid, m.perpSzDecimals);
  const spotSize = roundSz(notionalUsd / m.spotMid, m.spotSzDecimals);
  if (Number(perpSize) <= 0 || Number(spotSize) <= 0) throw new Error('notional too small for lot size');

  const fills: unknown[] = [];
  const perpFill = await iocOrder(client, m.perpAssetId, false, px(m.perpMid * (1 - LIVE_SLIPPAGE)), perpSize);
  fills.push({ leg: 'perp-short', ...perpFill });
  try {
    const spotFill = await iocOrder(client, m.spotAssetId, true, px(m.spotMid * (1 + LIVE_SLIPPAGE)), spotSize);
    fills.push({ leg: 'spot-long', ...spotFill });
  } catch (err) {
    // 现货腿失败 → 立即回滚永续腿（damage control 优先）
    await iocOrder(client, m.perpAssetId, true, px(m.perpMid * (1 + LIVE_SLIPPAGE)), perpSize, true).catch((e) =>
      log.error('live_rollback_failed', { owner, asset, error: String(e) }),
    );
    throw new Error(`spot leg failed, perp rolled back: ${String(err).slice(0, 150)}`);
  }
  log.info('live_open', { owner, asset, notionalUsd });
  return { fills, spotMarket: m.spotPair, perpMarket: `${asset}-PERP` };
}

/** 真实平仓：卖现货 + 买回永续（reduceOnly） */
export async function liveCloseCarry(owner: string, position: PositionRecord) {
  const client = exchangeClientFor(owner);
  const m = await resolveAsset(position.asset);
  const perpSize = roundSz(position.notionalUsd / m.perpMid, m.perpSzDecimals);
  const spotSize = roundSz(position.notionalUsd / m.spotMid, m.spotSzDecimals);
  const fills: unknown[] = [];
  const perpFill = await iocOrder(client, m.perpAssetId, true, px(m.perpMid * (1 + LIVE_SLIPPAGE)), perpSize, true);
  fills.push({ leg: 'perp-close', ...perpFill });
  const spotFill = await iocOrder(client, m.spotAssetId, false, px(m.spotMid * (1 - LIVE_SLIPPAGE)), spotSize);
  fills.push({ leg: 'spot-close', ...spotFill });
  log.info('live_close', { owner, asset: position.asset });
  return { fills };
}

/** 实盘账户观测：余额、真实仓位、近期资金费收付 */
export async function fetchLiveAccount(owner: string) {
  const user = owner as `0x${string}`;
  const [clearing, spot, funding] = await Promise.all([
    infoClient.clearinghouseState({ user }),
    infoClient.spotClearinghouseState({ user }),
    infoClient.userFunding({ user, startTime: Date.now() - 7 * 24 * 3600e3 }),
  ]);
  return {
    accountValueUsd: Number(clearing.marginSummary.accountValue),
    withdrawable: Number(clearing.withdrawable),
    perpPositions: clearing.assetPositions.map((p) => ({
      coin: p.position.coin,
      size: Number(p.position.szi),
      entryPx: Number(p.position.entryPx ?? 0),
      unrealizedPnl: Number(p.position.unrealizedPnl),
      liquidationPx: p.position.liquidationPx ? Number(p.position.liquidationPx) : null,
      marginUsed: Number(p.position.marginUsed),
    })),
    spotBalances: spot.balances.filter((b) => Number(b.total) > 0).map((b) => ({ coin: b.coin, total: Number(b.total) })),
    fundingLast7d: funding.slice(-50).map((f) => ({ time: f.time, coin: f.delta.coin, usdc: Number(f.delta.usdc), rate: Number(f.delta.fundingRate) })),
  };
}
