import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { verifyMessage } from 'viem';

/** 钱包签名登录：nonce → personal_sign → 验签 → HMAC session token。仅身份，不涉及资金。 */

const SECRET_FILE = 'data/session-secret';
function loadSecret(): Buffer {
  try {
    return Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
  } catch {
    mkdirSync('data', { recursive: true });
    const s = randomBytes(32);
    writeFileSync(SECRET_FILE, s.toString('hex'), { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const SESSION_TTL_MS = 7 * 24 * 3600e3;

const nonces = new Map<string, { message: string; at: number }>();

export function issueNonce(address: string): { message: string } {
  const addr = address.toLowerCase();
  const nonce = randomBytes(16).toString('hex');
  const message = `CarryPilot 登录验证（仅身份，不发生任何交易或资金操作）\n\nWallet: ${addr}\nNonce: ${nonce}\nIssued: ${new Date().toISOString()}`;
  nonces.set(addr, { message, at: Date.now() });
  return { message };
}

export async function verifyAndIssueToken(address: string, signature: `0x${string}`): Promise<string | null> {
  const addr = address.toLowerCase();
  const entry = nonces.get(addr);
  if (!entry || Date.now() - entry.at > 10 * 60e3) return null;
  const ok = await verifyMessage({ address: address as `0x${string}`, message: entry.message, signature }).catch(() => false);
  if (!ok) return null;
  nonces.delete(addr);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${addr}.${exp}`;
  const mac = createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${mac}`).toString('base64url');
}

export function authenticate(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const [addr, expStr, mac] = Buffer.from(authHeader.slice(7), 'base64url').toString().split('.');
    if (!addr || !expStr || !mac) return null;
    if (Number(expStr) < Date.now()) return null;
    const expect = createHmac('sha256', SECRET).update(`${addr}.${expStr}`).digest('hex');
    return mac === expect ? addr : null;
  } catch {
    return null;
  }
}
