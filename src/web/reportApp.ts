import express, { type Express, type ErrorRequestHandler } from 'express';
import { injectivePaymentMiddleware } from '@injectivelabs/x402/middleware';
import { log } from '../lib/logger.js';
import type { Candidate } from '../core/candidates.js';
import type { RateRow } from './agentApi.js';

/**
 * x402 付费端点：/api/agent/report。挂一个只有这一条路由的小 Express app，
 * 用原生 http server 按 path 转发进来（Express app 本身就是合法的 (req,res) handler）。
 * 免费端点（/api/agent/query、/api/a2a、/mcp）完全不受影响，独立于这层。
 */

export interface ReportSource {
  getReport(): Promise<{ candidates: Candidate[]; rates: RateRow[]; generatedAt: string }>;
}

const PRICE_USDC_UNITS = '10000'; // 6 decimals = 0.01 USDC，演示用最小额度

export function buildReportApp(source: ReportSource): Express | null {
  const enabled = process.env.X402_ENABLED === 'true';
  const treasuryPk = process.env.X402_TREASURY_PRIVATE_KEY as `0x${string}` | undefined;
  const treasuryAddr = process.env.X402_TREASURY_ADDRESS as `0x${string}` | undefined;
  const network = (process.env.X402_NETWORK ?? 'eip155:1439') as 'eip155:1439' | 'eip155:1776';
  const usdcAddr = process.env.X402_USDC_ADDRESS as `0x${string}` | undefined;
  if (!enabled || !treasuryPk || !treasuryAddr || !usdcAddr) return null;

  const app = express();
  // 强制走 Express 生产错误处理（不回显堆栈/内部路径），不依赖进程级 NODE_ENV
  app.set('env', 'production');
  app.use(
    injectivePaymentMiddleware(
      {
        'GET /api/agent/report': {
          description: 'CarryPilot 完整套利报告（全市场候选 + 全费率表，非摘要）',
          mimeType: 'application/json',
          accepts: [{ network, asset: usdcAddr, amount: PRICE_USDC_UNITS, payTo: treasuryAddr, maxTimeoutSeconds: 120 }],
        },
      },
      { facilitator: { privateKey: treasuryPk } },
    ),
  );

  app.get('/api/agent/report', async (_req, res, next) => {
    try {
      const { candidates, rates, generatedAt } = await source.getReport();
      res.json({
        generatedAt,
        priceUsdc: Number(PRICE_USDC_UNITS) / 1e6,
        rates,
        candidates,
        disclaimer: '研究结论，非投资建议。已付费结算，全量数据（免费端点只返回摘要/Top N）。',
      });
    } catch (err) {
      next(err);
    }
  });

  // 兜底错误处理：绝不回显堆栈或内部信息给已付费的调用方
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const logId = log.errorId('report_app_error', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error', logId });
  };
  app.use(onError);

  return app;
}
