/**
 * 端到端验收测试（对运行中的服务执行）：
 *   BASE_URL=http://localhost:8092 npx tsx scripts/acceptance.ts
 * 模拟真实用户：生成钱包 → 签名登录 → 创建 Agent → 等待引擎决策 → 校验。
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
let pass = 0;
let fail = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  ok ? pass++ : fail++;
  results.push(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const j = (r: Response) => r.json() as Promise<any>;

// ---------- AC-A 公开数据面 ----------
const scan = await j(await fetch(`${BASE}/api/scan`));
check('A1 扫描接口可用', Array.isArray(scan.candidates) && scan.candidates.length > 0, `${scan.candidates?.length} 候选`);
check('A2 仅 HL 站内 S1（无跨所）', scan.candidates.every((c: any) => c.strategy === 'S1_SPOT_PERP'));
check('A3 费率中心数据存在', Array.isArray(scan.rates) && scan.rates.length >= 10, `${scan.rates?.length} 个市场`);

// AC-B 确定性数学一致（PRD AC-08 精神）
let mathOk = true;
let decisionOk = true;
for (const c of scan.candidates) {
  const costSum = c.costs.reduce((a: number, x: any) => a + x.pct, 0);
  if (Math.abs(costSum - c.totalCostPct) > 1e-9) mathOk = false;
  if (Math.abs(c.grossFundingPct - c.totalCostPct - c.netHorizonPct) > 1e-9) mathOk = false;
  const shouldAccept = c.rejectionCodes.length === 0;
  if ((c.decision === 'ACCEPTED') !== shouldAccept) decisionOk = false;
  if (c.decision === 'ACCEPTED' && !(c.netHorizonPct > 0 && c.costCoverage >= 2)) decisionOk = false;
}
check('B1 成本瀑布数学自洽', mathOk);
check('B2 决策与拒绝码一致（AC-01/AC-08）', decisionOk);
const rejected = scan.candidates.filter((c: any) => c.decision === 'REJECTED');
check('B3 存在明确拒绝（“没有机会也是结论”）', rejected.length > 0, rejected.map((c: any) => c.rejectionCodes[0]).slice(0, 3).join(','));

// ---------- AC-C 认证与权限 ----------
const noAuth = await fetch(`${BASE}/api/me`);
check('C1 未登录访问被拒', noAuth.status === 401);
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const badVerify = await fetch(`${BASE}/api/auth/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: account.address, signature: '0x' + 'ab'.repeat(65) }),
});
check('C2 伪造签名被拒', badVerify.status === 401);
const { message } = await j(await fetch(`${BASE}/api/auth/nonce?address=${account.address}`));
const signature = await account.signMessage({ message });
const { token } = await j(
  await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: account.address, signature }) }),
);
check('C3 真实签名登录成功', Boolean(token));
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

// ---------- AC-P 积分体系 ----------
const me0 = await j(await fetch(`${BASE}/api/me`, { headers: auth }));
check('P1 新用户获得体验积分', me0.points?.balance > 0, `balance=${me0.points?.balance}`);
check('P2 积分接口含充值信息', typeof me0.points?.depositFromInj === 'string' && me0.points.depositFromInj.startsWith('inj1'), me0.points?.depositFromInj?.slice(0, 12));
const pts = await j(await fetch(`${BASE}/api/points`, { headers: auth }));
check('P3 积分流水可查', Array.isArray(pts.history) && pts.history.some((h: any) => h.kind === 'welcome'));

// ---------- AC-D Agent 生命周期与风控上限 ----------
const live = await j(await fetch(`${BASE}/api/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'LIVE', capitalUsd: 500, asset: 'ALL', style: 'balanced' }) }));
check('D1 未授权钱包禁止创建实盘 Agent', Boolean(live.error));
const created = await j(
  await fetch(`${BASE}/api/agents`, { method: 'POST', headers: auth, body: JSON.stringify({ name: '验收Agent', mode: 'PAPER', capitalUsd: 999999999, asset: 'ALL', style: 'aggressive' }) }),
);
check('D2 模拟 Agent 创建成功', Boolean(created.agent?.id));
check('D3 资金被硬顶限制（RiskGuard）', created.agent?.capitalUsd <= 100000, `capital=${created.agent?.capitalUsd}`);

// ---------- AC-E 引擎决策（等待 ≤75s 一个 tick） ----------
console.log('等待引擎 tick（≤75s）…');
let me: any = null;
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  me = await j(await fetch(`${BASE}/api/me`, { headers: auth }));
  const agent = me.agents.find((a: any) => a.id === created.agent.id);
  if (agent && agent.log.length > 1) break;
}
const agent = me.agents.find((a: any) => a.id === created.agent.id);
check('E1 引擎产生决策日志', agent?.log.length > 1, agent?.log.at(-1)?.msg?.slice(0, 80));
const opened = me.positions.filter((p: any) => p.agentId === agent?.id);
const hadEligible = scan.candidates.some((c: any) => c.decision === 'ACCEPTED' && c.netApr >= 4);
check('E2 有合格机会时开仓/无机会时空仓（行为一致）', hadEligible ? opened.length > 0 : opened.length === 0, `eligible=${hadEligible}, opened=${opened.length}`);
if (opened.length) {
  const v = opened[0];
  check('E3 持仓具备观测字段（收益/风险/费率）', v.risk?.level !== undefined && v.currentHourlyFundingPct !== undefined && typeof v.pnlUsd === 'number', `risk=${v.risk?.level}`);
}
check('E4 收益曲线快照存在', Array.isArray(agent?.equitySeries) && agent.equitySeries.length > 0);
const meAfterTick = await j(await fetch(`${BASE}/api/me`, { headers: auth }));
check('E5 tick 扣积分生效', meAfterTick.points.balance < me0.points.balance || agent?.log.some((l: any) => l.msg.includes('积分不足')), `before=${me0.points.balance} after=${meAfterTick.points.balance}`);

// ---------- AC-F 平仓与收尾 ----------
if (opened.length) {
  const closed = await j(await fetch(`${BASE}/api/positions/close`, { method: 'POST', headers: auth, body: JSON.stringify({ id: opened[0].id }) }));
  check('F1 手动平仓 + Receipt 哈希', closed.position?.status === 'CLOSED' && /^[0-9a-f]{64}$/.test(closed.position?.receiptHash ?? ''), closed.position?.receiptHash?.slice(0, 12));
}
await fetch(`${BASE}/api/agents/action`, { method: 'POST', headers: auth, body: JSON.stringify({ id: created.agent.id, action: 'stop' }) });
const afterStop = await j(await fetch(`${BASE}/api/me`, { headers: auth }));
check('F2 Agent 可停止', afterStop.agents.find((a: any) => a.id === created.agent.id)?.status === 'STOPPED');

console.log('\n===== 验收结果 =====');
for (const r of results) console.log(r);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
