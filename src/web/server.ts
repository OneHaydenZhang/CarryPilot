import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { issueNonce, verifyAndIssueToken, authenticate } from '../lib/auth.js';
import { fetchPerpSnapshots, fetchSpotSnapshots, type HlPerpSnapshot, type HlSpotSnapshot } from '../connectors/hyperliquid.js';
import { buildS1Candidates, ENGINE_VERSION, CONFIG, setDemo, demoFundingFor, type Candidate } from '../core/candidates.js';
import { loadStore, saveStore, store, virtualBalanceOf, setVirtualBalance } from '../core/store.js';
import { tickAgents, closePosition, viewPosition, buildManualPosition, STYLE_PARAMS, LIMITS, type LiveExecutor } from '../core/agents.js';
import { llmEnabled } from '../core/llm.js';
import { balanceOf, grantWelcomeIfNew, scanDepositsFor, historyOf, treasuryInj, treasuryEvm, POINT_PRESETS, POINTS } from '../core/points.js';
import { buildApproveAgentTypedData, submitApproveAgent, liveOpenCarry, liveCloseCarry, fetchLiveAccount, getOrCreateAgentWallet } from '../connectors/hlExchange.js';
import { agentCard, classify, answerRates, answerOpportunities, handleA2A } from './agentApi.js';
import { handleMcpRequest } from './mcpServer.js';
import { buildReportApp } from './reportApp.js';

const PORT = Number(process.env.PORT ?? 8080);
const CACHE_TTL_MS = 60_000;
const __dir = dirname(fileURLToPath(import.meta.url));
const pages = {
  landing: readFileSync(join(__dir, 'landing.html')),
  app: readFileSync(join(__dir, 'app.html')),
  agentDocs: readFileSync(join(__dir, 'agent-docs.html')),
  agentDocsEn: readFileSync(join(__dir, 'agent-docs.en.html')),
  userGuide: readFileSync(join(__dir, 'user-guide.html')),
  userGuideEn: readFileSync(join(__dir, 'user-guide.en.html')),
  favicon: readFileSync(join(__dir, 'favicon.svg')),
};

const DISCLAIMER =
  '本平台输出为研究结论与模拟/实盘执行记录，不构成投资建议或收益承诺。资金费率、滑点、流动性与保证金风险可能快速变化。实盘模式使用无提币权限的 API wallet，仍存在交易亏损风险，请仅使用可承受损失的资金。';

// ---------- 扫描缓存 ----------
interface ScanState {
  generatedAt: string;
  candidates: Candidate[];
  perps: HlPerpSnapshot[];
  spots: HlSpotSnapshot[];
  sourcesOk: boolean;
}
let scan: ScanState | null = null;
let scanning: Promise<ScanState> | null = null;
const fundingHistCache = new Map<string, { at: number; data: unknown }>();

/** 对外只展示模型家族名，不暴露路由商与版本号 */
function llmDisplayName(): string {
  const m = (process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat').toLowerCase();
  if (m.includes('deepseek')) return 'DeepSeek';
  if (m.includes('claude')) return 'Claude';
  if (m.includes('gpt') || m.includes('openai')) return 'GPT';
  if (m.includes('gemini')) return 'Gemini';
  if (m.includes('qwen')) return 'Qwen';
  return 'AI';
}

let demoInit = false;
async function refreshScan(): Promise<ScanState> {
  const observedAt = new Date().toISOString();
  const [perpsR, spotsR] = await Promise.allSettled([fetchPerpSnapshots(), fetchSpotSnapshots()]);
  if (perpsR.status === 'rejected') throw new Error('HL perps source failed');
  const perps = perpsR.value;
  const spots = spotsR.status === 'fulfilled' ? spotsR.value : [];
  // DEMO 模式：首次拉到数据后，挑 3 个「有现货可对冲」的知名标的作为演示机会
  if (process.env.DEMO_MODE === 'true' && !demoInit && spots.length) {
    demoInit = true;
    const sb = new Set(spots.map((s) => s.baseToken));
    const prefer = ['BTC', 'ETH', 'SOL', 'HYPE'].filter((c) => sb.has(c) || sb.has(CONFIG.wrapperMap[c] ?? ''));
    const extra = perps.map((p) => p.coin).filter((c) => (sb.has(c) || sb.has(CONFIG.wrapperMap[c] ?? '')) && !prefer.includes(c));
    setDemo([...prefer, ...extra].slice(0, 3));
    log.info('demo_mode_on', { coins: [...prefer, ...extra].slice(0, 3) });
  }
  const candidates = buildS1Candidates(perps, spots, observedAt);
  scan = { generatedAt: observedAt, candidates, perps, spots, sourcesOk: spotsR.status === 'fulfilled' };
  return scan;
}
async function getScan(): Promise<ScanState> {
  if (scan && Date.now() - Date.parse(scan.generatedAt) < CACHE_TTL_MS) return scan;
  scanning ??= refreshScan().finally(() => (scanning = null));
  return scanning;
}

// ---------- helpers ----------
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return {};
  }
}
const JSON_PARSE_FAILED = Symbol('json_parse_failed');
async function readBodyStrict(req: IncomingMessage): Promise<Record<string, unknown> | typeof JSON_PARSE_FAILED> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    return JSON_PARSE_FAILED;
  }
}
const spotByBase = () => new Map((scan?.spots ?? []).map((s) => [s.baseToken, s]));
function buildRates(s: ScanState) {
  const sb = spotByBase();
  return s.perps.map((p) => {
    const f = demoFundingFor(p.coin) ?? p.hourlyFunding; // demo 标的费率与机会保持一致
    return {
      coin: p.coin,
      hourlyFundingPct: f * 100,
      annualizedPct: f * 24 * 365 * 100,
      markPx: p.markPx,
      hasSpot: sb.has(p.coin) || sb.has(CONFIG.wrapperMap[p.coin] ?? ''),
    };
  });
}

// ---------- x402 付费报告（挂一个只有这一条路由的 Express app）----------
const reportApp = buildReportApp({
  async getReport() {
    const s = await getScan();
    return { candidates: s.candidates, rates: buildRates(s), generatedAt: s.generatedAt };
  },
});

// ---------- 路由 ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  try {
    if (path === '/') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.landing);
    if (path === '/app') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.app);
    if (path === '/agents') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.agentDocs);
    if (path === '/en/agents') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.agentDocsEn);
    if (path === '/guide') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.userGuide);
    if (path === '/en/guide') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages.userGuideEn);
    if (path === '/api/health') return json(res, 200, { status: 'ok', engineVersion: ENGINE_VERSION, network: config.network });
    if (path === '/favicon.svg' || path === '/favicon.ico')
      return void res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }).end(pages.favicon);

    // ---- 对外 Agent 能力（A2A / MCP 地基，只读免鉴权）----
    if (path === '/.well-known/agent-card.json' || path === '/api/agent/card') {
      return json(res, 200, agentCard());
    }
    if (path === '/api/agent/query') {
      const q = req.method === 'POST' ? String((await readBody(req)).query ?? '') : (url.searchParams.get('q') ?? '');
      if (!q.trim()) return json(res, 400, { error: 'empty query', hint: '传 ?q=... 或 POST {query}. 例：BTC 资金费率 / 现在有什么套利机会' });
      const s = await getScan();
      const rates = buildRates(s);
      const { intent, coin } = classify(
        q,
        rates.map((r) => r.coin),
      );
      const generatedAt = s.generatedAt;
      if (intent === 'arbitrage_opportunity') return json(res, 200, { query: q, coin, generatedAt, disclaimer: DISCLAIMER, ...answerOpportunities(s.candidates, coin) });
      if (intent === 'funding_rates') return json(res, 200, { query: q, coin, generatedAt, disclaimer: DISCLAIMER, ...answerRates(rates, coin) });
      return json(res, 200, {
        query: q,
        intent: 'unknown',
        generatedAt,
        message: '我能回答两类问题：① 资金费率（如「BTC 费率多少」「哪些币费率最高」）② 套利机会（如「现在有什么套利机会」「ETH 值得做吗」）。',
        skills: ['funding_rates', 'arbitrage_opportunity'],
      });
    }

    // ---- A2A：标准 JSON-RPC 2.0 message/send（其他 Agent 用 A2A 协议调用本 Agent）----
    if (path === '/api/a2a' && req.method === 'POST') {
      const body = await readBodyStrict(req);
      if (body === JSON_PARSE_FAILED) return json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } });
      const s = await getScan();
      return json(res, 200, handleA2A(body, { rates: buildRates(s), candidates: s.candidates, generatedAt: s.generatedAt }));
    }

    // ---- MCP：Streamable HTTP（其他 Agent host 用标准 MCP client 接入）----
    if (path === '/mcp') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        return void (await handleMcpRequest(req, res, body));
      }
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' }, id: null });
    }

    // ---- x402：付费完整报告（EIP-3009 gasless USDC，Injective 链）----
    if (path === '/api/agent/report') {
      if (!reportApp) return json(res, 501, { error: 'x402 not configured on this deployment' });
      return void reportApp(req, res);
    }

    if (path === '/api/scan') {
      const s = await getScan();
      const sb = spotByBase();
      const rates = s.perps
        .map((p) => {
          const f = demoFundingFor(p.coin) ?? p.hourlyFunding; // demo 标的费率与机会一致
          return {
            coin: p.coin,
            hourlyFundingPct: f * 100,
            annualizedPct: f * 24 * 365 * 100,
            markPx: p.markPx,
            oiUsd: Math.round(p.openInterest * p.markPx),
            hasSpot: sb.has(p.coin) || sb.has(CONFIG.wrapperMap[p.coin] ?? ''),
          };
        })
        .sort((a, b) => Math.abs(b.hourlyFundingPct) - Math.abs(a.hourlyFundingPct));
      return json(res, 200, {
        generatedAt: s.generatedAt,
        network: config.network,
        engineVersion: ENGINE_VERSION,
        horizonHours: CONFIG.horizonHours,
        llm: { enabled: llmEnabled(), name: llmDisplayName() },
        candidates: s.candidates,
        rates: rates.slice(0, 60),
        disclaimer: DISCLAIMER,
      });
    }

    if (path === '/api/funding-history') {
      const coin = (url.searchParams.get('coin') ?? '').toUpperCase();
      if (!/^[A-Z0-9]{1,15}$/.test(coin)) return json(res, 400, { error: 'bad coin' });
      const hit = fundingHistCache.get(coin);
      if (hit && Date.now() - hit.at < 30 * 60e3) return json(res, 200, hit.data);
      const { postJson } = await import('../lib/http.js');
      const raw = await postJson<{ time: number; fundingRate: string }[]>(`${config.hl.api}/info`, {
        type: 'fundingHistory',
        coin,
        startTime: Date.now() - 7 * 24 * 3600e3,
      });
      const data = { coin, points: raw.map((r) => ({ time: r.time, hourlyPct: Number(r.fundingRate) * 100 })) };
      fundingHistCache.set(coin, { at: Date.now(), data });
      return json(res, 200, data);
    }

    if (path === '/api/auth/nonce') {
      const address = url.searchParams.get('address') ?? '';
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(res, 400, { error: 'bad address' });
      return json(res, 200, issueNonce(address));
    }
    if (path === '/api/auth/verify' && req.method === 'POST') {
      const b = await readBody(req);
      const token = await verifyAndIssueToken(String(b.address ?? ''), String(b.signature ?? '') as `0x${string}`);
      return token ? json(res, 200, { token }) : json(res, 401, { error: 'signature verification failed' });
    }

    // ---- 以下需登录 ----
    const owner = authenticate(req.headers.authorization);
    if (!owner) return json(res, 401, { error: 'unauthorized' });

    if (path === '/api/me') {
      grantWelcomeIfNew(owner);
      const agents = store.agents.filter((a) => a.owner === owner);
      const positions = store.positions.filter((p) => p.owner === owner).map(viewPosition);
      const wallet = store.wallets.find((w) => w.owner === owner);
      const summaryFor = (mode: 'PAPER' | 'LIVE') => {
        const ps = positions.filter((p) => p.mode === mode);
        return {
          totalPnl: ps.reduce((a, p) => a + p.pnlUsd, 0),
          openCount: ps.filter((p) => p.status === 'OPEN').length,
          fundingAccrued: ps.reduce((a, p) => a + p.fundingAccruedUsd, 0),
        };
      };
      return json(res, 200, {
        address: owner,
        agents,
        positions,
        styleParams: STYLE_PARAMS,
        limits: LIMITS,
        llmEnabled: llmEnabled(),
        tickMinutes: 10,
        virtualBalance: virtualBalanceOf(owner),
        live: { agentAddress: wallet?.agentAddress ?? null, approved: Boolean(wallet?.approvedAt) },
        summary: { PAPER: summaryFor('PAPER'), LIVE: summaryFor('LIVE') },
        points: { balance: balanceOf(owner), perTick: POINTS.perTick, rateInj: POINTS.rateInj, configured: Boolean(treasuryInj()), presets: POINT_PRESETS, treasuryEvm: treasuryEvm() },
      });
    }

    if (path === '/api/prefs' && req.method === 'POST') {
      const b = await readBody(req);
      setVirtualBalance(owner, Number(b.virtualBalanceUsd) || 10000);
      saveStore();
      return json(res, 200, { virtualBalance: virtualBalanceOf(owner) });
    }

    if (path === '/api/points') {
      return json(res, 200, { balance: balanceOf(owner), history: historyOf(owner), treasury: treasuryInj(), rateInj: POINTS.rateInj, perTick: POINTS.perTick });
    }
    if (path === '/api/points/refresh' && req.method === 'POST') {
      const r = await scanDepositsFor(owner);
      return json(res, 200, { ...r, balance: balanceOf(owner) });
    }

    if (path === '/api/agents' && req.method === 'POST') {
      grantWelcomeIfNew(owner); // 确保创建即有燃料（否则 triggerEngineSoon 的首个 tick 会因 0 积分即停）
      const b = await readBody(req);
      const mine = store.agents.filter((a) => a.owner === owner);
      if (mine.length >= LIMITS.maxAgentsPerUser) return json(res, 400, { error: `每个用户最多 ${LIMITS.maxAgentsPerUser} 个 Agent` });
      const mode = b.mode === 'LIVE' ? 'LIVE' : 'PAPER';
      const cap = mode === 'LIVE' ? LIMITS.maxLiveCapitalUsd : Math.min(LIMITS.maxPaperCapitalUsd, virtualBalanceOf(owner));
      const capitalUsd = Math.min(Math.max(Number(b.capitalUsd) || 0, LIMITS.minCapitalUsd), cap);
      if (mode === 'LIVE' && !store.wallets.find((w) => w.owner === owner)?.approvedAt)
        return json(res, 400, { error: '实盘模式需先完成 API Wallet 授权（收益中心→实盘设置）' });
      const style = ['conservative', 'balanced', 'aggressive'].includes(String(b.style)) ? (b.style as keyof typeof STYLE_PARAMS) : 'balanced';
      const maxRounds = Math.min(Math.max(Math.round(Number(b.maxRounds) || 120), 10), 120);
      const agent = {
        id: crypto.randomUUID().slice(0, 8),
        owner,
        name: String(b.name || `Agent-${mine.length + 1}`).slice(0, 30),
        asset: String(b.asset || 'ALL').toUpperCase(),
        style,
        capitalUsd,
        mode: mode as 'PAPER' | 'LIVE',
        status: 'RUNNING' as const,
        createdAt: new Date().toISOString(),
        log: [{ at: new Date().toISOString(), msg: `Agent 创建（${mode === 'LIVE' ? '实盘' : '模拟'} · ${STYLE_PARAMS[style].label} · $${capitalUsd} · ${maxRounds} 回合${b.customPrompt ? ' · 自定义指令已设置' : ''}）` }],
        equitySeries: [],
        maxRounds,
        rounds: 0,
        customPrompt: String(b.customPrompt ?? '').slice(0, 500),
      };
      store.agents.push(agent);
      saveStore();
      triggerEngineSoon();
      return json(res, 200, { agent });
    }

    if (path === '/api/agents/action' && req.method === 'POST') {
      const b = await readBody(req);
      const agent = store.agents.find((a) => a.id === b.id && a.owner === owner);
      if (!agent) return json(res, 404, { error: 'agent not found' });
      const open = store.positions.find((p) => p.agentId === agent.id && p.status === 'OPEN');
      if (b.action === 'stop') {
        agent.status = 'STOPPED';
        if (open) {
          if (open.mode === 'LIVE') {
            try {
              const r = await liveCloseCarry(owner, open);
              open.fills = [...(open.fills ?? []), ...r.fills];
            } catch (err) {
              const logId = log.errorId('live_close_on_stop_failed', err, { owner, agentId: agent.id, positionId: open.id });
              agent.log.push({ at: new Date().toISOString(), msg: `⚠ 停止时实盘平仓失败: ${String(err).slice(0, 100)}（错误码 ${logId}）` });
              saveStore();
              return json(res, 500, { error: '实盘平仓失败，Agent 已停止但仓位仍在，请稍后手动平仓', logId });
            }
          }
          closePosition(open, 'AGENT_STOPPED');
        }
      } else if (b.action === 'start') {
        agent.status = 'RUNNING';
        triggerEngineSoon();
      }
      else if (b.action === 'delete') {
        if (open) return json(res, 400, { error: '有持仓的 Agent 不能删除，请先停止' });
        store.agents.splice(store.agents.indexOf(agent), 1);
      }
      saveStore();
      return json(res, 200, { ok: true });
    }

    if (path === '/api/positions/close' && req.method === 'POST') {
      const b = await readBody(req);
      const pos = store.positions.find((p) => p.id === b.id && p.owner === owner && p.status === 'OPEN');
      if (!pos) return json(res, 404, { error: 'position not found' });
      if (pos.mode === 'LIVE') {
        try {
          const r = await liveCloseCarry(owner, pos);
          pos.fills = [...(pos.fills ?? []), ...r.fills];
        } catch (err) {
          const logId = log.errorId('live_close_failed', err, { owner, positionId: pos.id });
          return json(res, 500, { error: `实盘平仓失败: ${String(err).slice(0, 150)}`, logId });
        }
      }
      closePosition(pos, 'MANUAL');
      saveStore();
      return json(res, 200, { position: viewPosition(pos) });
    }

    // ---- 对话式确认下单（Level 2 Assisted Execution）----
    if (path === '/api/agent/quote' && req.method === 'POST') {
      const b = await readBody(req);
      const asset = String(b.asset ?? '').toUpperCase();
      const mode = b.mode === 'LIVE' ? 'LIVE' : 'PAPER';
      const notionalUsd = Math.min(Math.max(Number(b.notionalUsd) || 0, 50), mode === 'LIVE' ? LIMITS.maxLiveCapitalUsd : Math.min(LIMITS.maxNotionalUsd, virtualBalanceOf(owner)));
      const s = await getScan();
      const c = s.candidates.find((x) => x.strategy === 'S1_SPOT_PERP' && x.asset === asset);
      if (!c) return json(res, 404, { error: `${asset} 无可评估的站内套利候选` });
      const feePct = CONFIG.takerFeePct.hyperliquid ?? 0.045;
      const oneTimeCostUsd = notionalUsd * ((feePct * 4 + 0.05) / 100);
      const hourlyPct = c.legs.find((l) => l.instrument === 'perp')?.hourlyFundingPct ?? 0;
      const perHour = (notionalUsd * hourlyPct) / 100;
      const risk = c.decision === 'ACCEPTED' ? (c.costCoverage >= 3 ? 'LOW' : 'MEDIUM') : 'HIGH';
      return json(res, 200, {
        asset,
        mode,
        notionalUsd,
        decision: c.decision,
        rejectionCodes: c.rejectionCodes,
        netApr: c.netApr,
        grossApr: c.grossApr,
        costCoverage: c.costCoverage,
        breakevenHours: c.breakevenHours,
        legs: c.legs,
        narrative: c.narrative,
        risk,
        estimate: {
          oneTimeCostUsd,
          per8hUsd: perHour * 8,
          perDayUsd: perHour * 24,
          perWeekUsd: perHour * 168,
          netPerWeekUsd: perHour * 168 - oneTimeCostUsd,
        },
        warning: c.decision === 'ACCEPTED' ? '费率随时会衰减或翻负，建议持有期间关注风险中心；这是持有型策略，需覆盖一次性成本后才净赚。' : '⚠ 此标的当前扣完成本为负，不建议开仓。',
        disclaimer: DISCLAIMER,
      });
    }

    if (path === '/api/agent/order' && req.method === 'POST') {
      const b = await readBody(req);
      const asset = String(b.asset ?? '').toUpperCase();
      const mode = b.mode === 'LIVE' ? 'LIVE' : 'PAPER';
      const cap = mode === 'LIVE' ? LIMITS.maxLiveCapitalUsd : Math.min(LIMITS.maxNotionalUsd, virtualBalanceOf(owner));
      const notionalUsd = Math.min(Math.max(Number(b.notionalUsd) || 0, 50), cap);
      if (mode === 'LIVE' && !store.wallets.find((w) => w.owner === owner)?.approvedAt) return json(res, 400, { error: '实盘下单需先授权 API Wallet（设置→交易授权）' });
      const s = await getScan();
      const c = s.candidates.find((x) => x.strategy === 'S1_SPOT_PERP' && x.asset === asset);
      if (!c) return json(res, 404, { error: `${asset} 无可评估的站内套利候选` });
      // RiskGuard：只允许开 ACCEPTED（对话确认下单同样受硬门约束，除非用户显式 force 覆盖研究结论——本期不允许）
      if (c.decision !== 'ACCEPTED') return json(res, 400, { error: `${asset} 当前扣完成本为负（${c.rejectionCodes.join(',')}），风控拒绝开仓` });
      const pos = buildManualPosition(owner, c, notionalUsd, mode);
      if (mode === 'LIVE') {
        try {
          const r = await liveOpenCarry(owner, asset, notionalUsd);
          pos.fills = r.fills;
          pos.spotMarket = r.spotMarket;
          pos.perpMarket = r.perpMarket;
        } catch (err) {
          return json(res, 500, { error: `实盘开仓失败（未建仓）: ${String(err).slice(0, 150)}` });
        }
      }
      store.positions.push(pos);
      saveStore();
      return json(res, 200, { ok: true, position: viewPosition(pos) });
    }

    if (path === '/api/live/typed-data' && req.method === 'POST') {
      return json(res, 200, buildApproveAgentTypedData(owner));
    }
    if (path === '/api/live/approve' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        await submitApproveAgent(owner, b.action as Record<string, unknown>, String(b.signature) as `0x${string}`);
        return json(res, 200, { ok: true, agentAddress: getOrCreateAgentWallet(owner).agentAddress });
      } catch (err) {
        const logId = log.errorId('live_approve_failed', err, { owner });
        return json(res, 400, { error: String(err).slice(0, 250), logId });
      }
    }
    if (path === '/api/live/account') {
      try {
        return json(res, 200, await fetchLiveAccount(owner));
      } catch (err) {
        const logId = log.errorId('live_account_fetch_failed', err, { owner });
        return json(res, 502, { error: String(err).slice(0, 200), logId });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const logId = log.errorId('http_error', err, { path });
    return json(res, 500, { error: 'internal error', logId });
  }
});

// ---------- Agent 引擎循环 ----------
const liveExecutor: LiveExecutor = {
  openCarry: liveOpenCarry,
  closeCarry: liveCloseCarry,
};
async function engineLoop(): Promise<void> {
  try {
    const s = await getScan();
    await tickAgents(s.candidates, liveExecutor);
  } catch (err) {
    log.error('engine_tick_failed', { error: String(err) });
  }
}

const TICK_MS = 10 * 60_000; // 10 分钟一回合（虚拟盘与实盘一致）
let engineRunning = false;
async function safeEngine(): Promise<void> {
  if (engineRunning) return;
  engineRunning = true;
  try {
    await engineLoop();
  } finally {
    engineRunning = false;
  }
}
/** 新建 Agent 后立即跑一回合，给用户即时反馈；之后每 10 分钟 */
export function triggerEngineSoon(): void {
  setTimeout(safeEngine, 300);
}

loadStore();
server.listen(PORT, () => log.info('web_up', { port: PORT, network: config.network, llm: llmEnabled(), tickMinutes: TICK_MS / 60000 }));
void safeEngine();
setInterval(safeEngine, TICK_MS);
