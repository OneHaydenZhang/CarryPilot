import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { fetchPerpSnapshots, fetchPredictedFundings, fetchSpotSnapshots } from '../connectors/hyperliquid.js';
import { fetchInjPerpSnapshots } from '../connectors/injective.js';
import { buildS1Candidates, buildS2Candidates, ENGINE_VERSION, CONFIG } from '../core/candidates.js';

const PORT = Number(process.env.PORT ?? 8080);
const CACHE_TTL_MS = 60_000;
const __dir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dir, 'index.html'));

const DISCLAIMER =
  '本结果用于研究与模拟，不构成投资建议、收益承诺、荐币、代客理财或适合性判断。资金费率、基差、滑点、流动性和保证金风险可能快速变化；历史与 paper 结果不代表未来表现。';

interface ScanPayload {
  generatedAt: string;
  network: string;
  engineVersion: string;
  horizonHours: number;
  sources: { name: string; status: 'ok' | 'failed'; detail?: string }[];
  candidates: unknown[];
  disclaimer: string;
}

let cache: { at: number; payload: ScanPayload } | null = null;
let scanning: Promise<ScanPayload> | null = null;

async function runScan(): Promise<ScanPayload> {
  const observedAt = new Date().toISOString();
  const [perps, spots, predicted, inj] = await Promise.allSettled([
    fetchPerpSnapshots(),
    fetchSpotSnapshots(),
    fetchPredictedFundings(),
    fetchInjPerpSnapshots(),
  ]);
  const sources: ScanPayload['sources'] = [
    { name: 'Hyperliquid perps (实时)', status: perps.status === 'fulfilled' ? 'ok' : 'failed' },
    { name: 'Hyperliquid spot (实时)', status: spots.status === 'fulfilled' ? 'ok' : 'failed' },
    { name: 'Binance/Bybit predicted (经HL聚合)', status: predicted.status === 'fulfilled' ? 'ok' : 'failed' },
    { name: 'Injective 链上LCD (估算)', status: inj.status === 'fulfilled' ? 'ok' : 'failed' },
  ];
  const hlPerps = perps.status === 'fulfilled' ? perps.value : [];
  if (!hlPerps.length) throw new Error('primary data source (HL) failed');

  const candidates = [
    ...buildS1Candidates(hlPerps, spots.status === 'fulfilled' ? spots.value : [], observedAt),
    ...buildS2Candidates(hlPerps, predicted.status === 'fulfilled' ? predicted.value : [], inj.status === 'fulfilled' ? inj.value : [], observedAt),
  ];
  return {
    generatedAt: observedAt,
    network: config.network,
    engineVersion: ENGINE_VERSION,
    horizonHours: CONFIG.horizonHours,
    sources,
    candidates,
    disclaimer: DISCLAIMER,
  };
}

async function getScan(): Promise<ScanPayload> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  scanning ??= runScan()
    .then((payload) => {
      cache = { at: Date.now(), payload };
      return payload;
    })
    .finally(() => (scanning = null));
  return scanning;
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  try {
    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', engineVersion: ENGINE_VERSION, cachedAt: cache?.payload.generatedAt ?? null }));
      return;
    }
    if (url === '/api/scan') {
      const payload = await getScan();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  } catch (err) {
    log.error('http_error', { url, error: String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(PORT, () => log.info('web_up', { port: PORT, network: config.network }));
