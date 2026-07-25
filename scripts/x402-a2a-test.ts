/**
 * A2A + x402 端到端验证：一个「调用方 Agent」发现 CarryPilot 的付费报告端点，
 * 用 x402（EIP-3009 gasless USDC）自动付费，拿到完整报告。
 * 运行（在能访问 Injective testnet 的机器上，如 US 服务器）：
 *   PAYER_PK=0x... BASE=https://carry-pilot.com npx tsx scripts/x402-a2a-test.ts
 */
import { privateKeyToAccount } from 'viem/accounts';
import { createInjectiveClient } from '@injectivelabs/x402/client';

const BASE = process.env.BASE ?? 'http://localhost';
const PAYER_PK = (process.env.PAYER_PK ?? '') as `0x${string}`;
if (!PAYER_PK) { console.error('set PAYER_PK'); process.exit(1); }
const payer = privateKeyToAccount(PAYER_PK);
console.log('payer:', payer.address, '\nendpoint:', BASE + '/api/agent/report');

// ① 先看 Agent Card 声明的付费能力
const card = await (await fetch(BASE + '/.well-known/agent-card.json')).json() as any;
console.log('\n[1] Agent Card payments:', JSON.stringify(card.payments ?? '(none)'));

// ② 不付费直接请求 → 期望 402 + 报价
const r0 = await fetch(BASE + '/api/agent/report');
console.log('\n[2] 无支付 → HTTP', r0.status, r0.status === 402 ? '✅ 402 Payment Required' : '❌');
const reqB64 = r0.headers.get('payment-required');
if (reqB64) { const q = JSON.parse(Buffer.from(reqB64, 'base64').toString()); console.log('    报价:', JSON.stringify(q.accepts?.[0])); }

// ③ x402 客户端自动付费（签 EIP-3009 → 重试 → 服务端结算）
console.log('\n[3] x402 自动付费（EIP-3009 签名 + 服务端链上结算）…');
const client = createInjectiveClient({ privateKey: PAYER_PK });
try {
  const r = await client.fetch(BASE + '/api/agent/report');
  console.log('    HTTP', r.status);
  const payResp = r.headers.get('payment-response');
  if (payResp) { const s = JSON.parse(Buffer.from(payResp, 'base64').toString()); console.log('    ✅ 结算回执:', JSON.stringify(s)); }
  const body = await r.json() as any;
  console.log('    报告拿到 ✅ candidates:', body.candidates?.length, 'rates:', body.rates?.length, 'priceUsdc:', body.priceUsdc);
} catch (e) {
  console.log('    结算未完成:', String((e as Error).message || e).slice(0, 240));
  console.log('    （若提示余额不足：给 payer 地址转 testnet USDC 后重试）');
}
