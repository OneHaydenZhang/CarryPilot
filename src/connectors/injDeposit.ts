import { MsgSend, createTransaction, ChainRestAuthApi, TxRestApi, CosmosTxV1Beta1TxPb } from '@injectivelabs/sdk-ts';
import { getDefaultStdFee } from '@injectivelabs/utils';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

/**
 * INJ 积分充值：原生 INJ MsgSend（用户 → 平台金库），完全对齐 Manek INJ AI 的流程。
 * 后端构造未签名 sign-doc → 前端 Cosmos 钱包（Keplr/Leap/OKX）signDirect → 后端广播。
 * 用 @injectivelabs/sdk-ts（pyinjective 的 Node 等价物）。
 */

const CHAIN_ID = config.network === 'testnet' ? 'injective-888' : 'injective-1';
// 官方 sentry LCD 国内 403；服务器在美国可达，本地用 publicnode。可用 INJ_LCD_URL 覆盖
const LCD = config.inj.lcd;

const b64ToBytes = (b: string) => new Uint8Array(Buffer.from(b, 'base64'));
const bytesToB64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/** 构造未签名交易（返回 bodyBytes/authInfoBytes 供钱包 signDirect） */
export async function buildDeposit(senderInj: string, treasuryInj: string, injAmount: number, pubKeyB64: string) {
  const authApi = new ChainRestAuthApi(LCD);
  const account = await authApi.fetchCosmosAccount(senderInj);
  const amount = BigInt(Math.round(injAmount * 1e6)) * 10n ** 12n; // inj → wei(1e18)，避免浮点
  const msg = MsgSend.fromJSON({
    srcInjectiveAddress: senderInj,
    dstInjectiveAddress: treasuryInj,
    amount: { denom: 'inj', amount: amount.toString() },
  });
  const { txRaw } = createTransaction({
    message: msg,
    memo: '',
    fee: getDefaultStdFee(),
    pubKey: pubKeyB64,
    sequence: Number(account.sequence),
    accountNumber: Number(account.account_number),
    chainId: CHAIN_ID,
  });
  return {
    bodyBytes: bytesToB64(txRaw.bodyBytes),
    authInfoBytes: bytesToB64(txRaw.authInfoBytes),
    accountNumber: String(account.account_number),
    chainId: CHAIN_ID,
    amountInj: injAmount,
  };
}

/** 广播钱包签名后的交易，返回 txhash */
export async function broadcastDeposit(bodyBytesB64: string, authInfoBytesB64: string, signatureB64: string): Promise<{ txHash: string }> {
  const txRaw = CosmosTxV1Beta1TxPb.TxRaw.create();
  txRaw.bodyBytes = b64ToBytes(bodyBytesB64);
  txRaw.authInfoBytes = b64ToBytes(authInfoBytesB64);
  txRaw.signatures = [b64ToBytes(signatureB64)];
  const txApi = new TxRestApi(LCD);
  const res = await txApi.broadcast(txRaw);
  if (res.code !== 0) throw new Error(`broadcast failed (code ${res.code}): ${String(res.rawLog).slice(0, 200)}`);
  log.info('inj_deposit_broadcast', { txHash: res.txHash });
  return { txHash: res.txHash };
}
