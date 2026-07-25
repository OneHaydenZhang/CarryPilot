import { randomBytes } from 'node:crypto';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** 短 id，日志里跟用户端展示的 logId 一一对应，方便 `journalctl | grep <id>` 定位 */
export function newLogId(): string {
  return randomBytes(5).toString('hex');
}

/** 附带堆栈的完整错误详情，只进日志，不回传给客户端 */
function errDetail(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
  /**
   * 报错时用这个：生成一个短 logId，把完整错误详情（含堆栈）连同 logId 一起写日志，
   * 返回 logId 给调用方塞进面向用户的响应里——用户报 logId，直接 `journalctl -u carrypilot | grep <id>` 定位。
   */
  errorId: (event: string, err: unknown, fields?: Record<string, unknown>): string => {
    const logId = newLogId();
    emit('error', event, { ...fields, ...errDetail(err), logId });
    return logId;
  },
};
