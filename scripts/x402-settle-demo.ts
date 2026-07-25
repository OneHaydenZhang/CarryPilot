/**
 * x402 端到端结算演示：用 X402_PAYER_PRIVATE_KEY 这个钱包（需持有 testnet USDC）
 * 真实付费拿 /api/agent/report。跑通后打印结算收据（含链上 tx hash）。
 * 前置：payer 钱包在 Injective testnet 有 ≥0.01 USDC；跑 `npx tsx scripts/x402-settle-demo.ts`
 */
import { createInjectiveClient } from '@injectivelabs/x402/client';

const BASE_URL = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080';
const payerKey = process.env.X402_PAYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!payerKey) throw new Error('X402_PAYER_PRIVATE_KEY not set');

const client = createInjectiveClient({ privateKey: payerKey });

console.log(`[1] 无支付访问 ${BASE_URL}/api/agent/report ...`);
const r1 = await fetch(`${BASE_URL}/api/agent/report`);
console.log('    HTTP', r1.status, r1.status === 402 ? '✅ 402 as expected' : '❌ unexpected');

console.log('\n[2] client 携带支付重试（EIP-3009 签名 + 结算）...');
const r2 = await client.fetch(`${BASE_URL}/api/agent/report`);
console.log('    HTTP', r2.status);
const receiptHeader = r2.headers.get('payment-response') ?? r2.headers.get('x-payment-response');
if (receiptHeader) {
  const receipt = JSON.parse(Buffer.from(receiptHeader, 'base64').toString());
  console.log('    结算收据:', JSON.stringify(receipt, null, 2));
  if (receipt.transaction) console.log(`    区块浏览器: https://testnet.blockscout.injective.network/tx/${receipt.transaction}`);
}
if (r2.status === 200) {
  const body = await r2.json();
  console.log('    报告字段:', Object.keys(body), '| candidates:', body.candidates?.length, '| rates:', body.rates?.length);
} else {
  console.log('    body:', (await r2.text()).slice(0, 300));
}
