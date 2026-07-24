#!/usr/bin/env node
/**
 * Telegram ⇄ Claude Code 桥接（零依赖，长轮询，无需公网端口）。
 *
 * 消息 → `claude -p` headless 运行于项目目录 → 输出回传 Telegram。
 * 会话经 --continue 延续；/new 开新会话。
 *
 * 安全模型：仅响应 TELEGRAM_ALLOWED_CHAT_ID 白名单；token/chat id 只放服务器
 * env 文件（/home/<user>/tg-bridge.env），永不入库。
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHAT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`;
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS ?? 30 * 60 * 1000);

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN missing');
  process.exit(1);
}

const api = (method, payload) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());

async function send(chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const chunk of chunks.length ? chunks : ['(空输出)']) {
    await api('sendMessage', { chat_id: chatId, text: chunk });
  }
}

import { spawn } from 'node:child_process';

let busy = false;
let continueSession = true; // false = 下一条消息开新会话

function runClaude(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--permission-mode', 'bypassPermissions'];
    if (continueSession) args.push('--continue');
    const child = spawn(CLAUDE_BIN, args, { cwd: PROJECT_DIR, env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      out += '\n[bridge] 超时被终止';
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      continueSession = true; // 首条之后都延续会话
      resolve(code === 0 ? out.trim() : `${out.trim()}\n[exit ${code}] ${err.trim().slice(-500)}`);
    });
  });
}

async function handle(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text ?? '').trim();
  if (!text) return;

  if (ALLOWED.length === 0) {
    await send(chatId, `bridge 未配置白名单。你的 chat id 是: ${chatId}\n把它填入服务器 tg-bridge.env 的 TELEGRAM_ALLOWED_CHAT_ID 后重启服务。`);
    return;
  }
  if (!ALLOWED.includes(chatId)) {
    console.log(`rejected chat ${chatId}`);
    return;
  }

  if (text === '/new') {
    continueSession = false;
    await send(chatId, '✅ 下一条消息将开启新会话');
    return;
  }
  if (text === '/status') {
    await send(chatId, `busy=${busy}\ndir=${PROJECT_DIR}\ncontinue=${continueSession}\nuptime=${Math.round(process.uptime())}s`);
    return;
  }
  if (busy) {
    await send(chatId, '⏳ 上一条还在执行，稍等（/status 查看状态）');
    return;
  }

  busy = true;
  await api('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const reply = await runClaude(text);
    await send(chatId, reply);
  } catch (e) {
    await send(chatId, `[bridge error] ${String(e).slice(0, 500)}`);
  } finally {
    busy = false;
  }
}

let offset = 0;
console.log(`bridge up. dir=${PROJECT_DIR} allowed=${ALLOWED.join(',') || '(unset)'}`);
for (;;) {
  try {
    const res = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    for (const u of res.result ?? []) {
      offset = u.update_id + 1;
      if (u.message) await handle(u.message);
    }
  } catch (e) {
    console.error('poll error', String(e).slice(0, 200));
    await new Promise((r) => setTimeout(r, 5000));
  }
}
