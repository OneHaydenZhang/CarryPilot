import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * MCP（Model Context Protocol）地基：把 /api/agent/query 包成两个 tool，
 * 供其他 agent host（Claude / Codex 等）以标准 MCP client 接入。
 * 无状态 Streamable HTTP：每次请求现建 server+transport，用完即关，不维护会话。
 */

const SELF_BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}`;

async function queryAgent(q: string): Promise<unknown> {
  const r = await fetch(`${SELF_BASE}/api/agent/query?q=${encodeURIComponent(q)}`);
  return r.json();
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'carrypilot', version: '0.6.0' }, { capabilities: {} });

  server.registerTool(
    'get_funding_rates',
    {
      description: '查询 Hyperliquid 某标的（或全市场费率绝对值最高的标的）当前资金费率、年化与是否有现货可对冲。',
      inputSchema: { coin: z.string().optional().describe('标的代码，如 BTC、ETH；留空返回费率绝对值最高的若干标的') },
    },
    async ({ coin }: { coin?: string }) => {
      const data = await queryAgent(coin ? `${coin} 资金费率` : '费率最高的标的');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    },
  );

  server.registerTool(
    'find_arbitrage',
    {
      description: '返回扣完全部成本（手续费+滑点+准备金）后的市场中性套利候选（现货多+永续空）：净APR、成本覆盖率、拒绝原因。',
      inputSchema: { coin: z.string().optional().describe('标的代码；留空返回全市场当前最优候选') },
    },
    async ({ coin }: { coin?: string }) => {
      const data = await queryAgent(coin ? `${coin} 套利机会` : '现在有什么套利机会');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    },
  );

  return server;
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, parsedBody: unknown): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}
