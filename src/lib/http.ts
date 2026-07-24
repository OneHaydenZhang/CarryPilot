import { log } from './logger.js';

export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
}

/** POST JSON，带超时 + 指数退避（含 jitter）。4xx（非 429）不重试。 */
export async function postJson<T>(url: string, body: unknown, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, timeoutMs = 10_000, baseDelayMs = 500 } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
        if (!retryable) throw err;
        lastError = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') lastError = new Error(`timeout after ${timeoutMs}ms: ${url}`);
      else lastError = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      const delay = baseDelayMs * 2 ** attempt * (1 + Math.random() * 0.3);
      log.warn('http_retry', { url, attempt: attempt + 1, delayMs: Math.round(delay) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
