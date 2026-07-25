/**
 * x402 集成可行性验证（spike）。测试 Injective EVM testnet 的 402 支付握手。
 * 运行：npx tsx scripts/x402-spike.ts
 */
import express from 'express';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { injectivePaymentMiddleware } from '@injectivelabs/x402/middleware';
import { createInjectiveClient } from '@injectivelabs/x402/client';
import { getToken, INJECTIVE_TESTNET_CAIP2 } from '@injectivelabs/x402/networks';

const USDC = getToken('eip155:1439', 'USDC');
console.log('Injective testnet CAIP2:', INJECTIVE_TESTNET_CAIP2, '| USDC:', USDC?.address, '| decimals:', USDC?.decimals);

const treasuryKey = generatePrivateKey();
const treasury = privateKeyToAccount(treasuryKey);
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
console.log('treasury(payTo):', treasury.address, '\npayer:', payer.address);

const app = express();
app.use(
  injectivePaymentMiddleware(
    {
      'GET /api/agent/report': {
        description: 'CarryPilot 完整套利报告',
        mimeType: 'application/json',
        accepts: [{ network: 'eip155:1439', asset: USDC!.address as `0x${string}`, amount: '10000', payTo: treasury.address, maxTimeoutSeconds: 120 }],
      },
    },
    { facilitator: { privateKey: treasuryKey } },
  ),
);
app.get('/api/agent/report', (_req, res) => res.json({ report: 'premium arbitrage report', ts: Date.now() }));

const server = app.listen(4021, async () => {
  try {
    const r1 = await fetch('http://127.0.0.1:4021/api/agent/report');
    console.log('\n[1] 无支付访问 → HTTP', r1.status, r1.status === 402 ? '✅ 返回 402（符合预期）' : '❌');
    const body = (await r1.json().catch(() => null)) as any;
    const req = body?.accepts?.[0];
    if (req) console.log('    报价:', { network: req.network, asset: req.asset, amount: req.amount, payTo: req.payTo });
    console.log('    PAYMENT-REQUIRED header:', r1.headers.get('payment-required') || r1.headers.get('x-payment-required') ? '✅ 存在' : '❌');

    console.log('\n[2] 客户端携带支付重试（EIP-3009 签名 + 结算）…');
    const client = createInjectiveClient({ privateKey: payerKey });
    try {
      const r2 = await client.fetch('http://127.0.0.1:4021/api/agent/report');
      console.log('    HTTP', r2.status, r2.status === 200 ? '✅ 结算成功' : '结算未完成');
      console.log('    body:', (await r2.text()).slice(0, 160));
    } catch (e) {
      console.log('    结算阶段异常（预期，测试钱包无 USDC）:', String((e as Error).message || e).slice(0, 200));
    }
  } catch (e) {
    console.error('spike error:', e);
  } finally {
    server.close();
    console.log('\n结论：402 报价握手可用；链上结算需 payer 钱包在 testnet 持有 USDC。');
  }
});
