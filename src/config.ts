import { z } from 'zod';

const EnvSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  TICK_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  TICK_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).default(5),
  /** INJ 链 REST(LCD) 端点；官方 sentry 有地域封锁，默认社区 publicnode */
  INJ_LCD_URL: z.string().url().optional(),
  // 交易/LLM 密钥在执行层与决策层接入时启用（雏形为免 key 的 dry-run 扫描）
  OPENROUTER_API_KEY: z.string().optional(),
  HL_ACCOUNT_ADDRESS: z.string().optional(),
  HL_API_WALLET_PRIVATE_KEY: z.string().optional(),
  INJ_PRIVATE_KEY: z.string().optional(),
});

const env = EnvSchema.parse(process.env);

const HL_ENDPOINTS = {
  mainnet: { api: 'https://api.hyperliquid.xyz', ws: 'wss://api.hyperliquid.xyz/ws' },
  testnet: { api: 'https://api.hyperliquid-testnet.xyz', ws: 'wss://api.hyperliquid-testnet.xyz/ws' },
} as const;

const INJ_LCD_DEFAULTS = {
  mainnet: 'https://injective-rest.publicnode.com',
  testnet: 'https://testnet.sentry.lcd.injective.network',
} as const;

export const config = {
  network: env.NETWORK,
  tickIntervalMs: env.TICK_INTERVAL_MS,
  tickTimeoutMs: env.TICK_TIMEOUT_MS,
  maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
  hl: HL_ENDPOINTS[env.NETWORK],
  inj: { lcd: env.INJ_LCD_URL ?? INJ_LCD_DEFAULTS[env.NETWORK] },
  secrets: {
    openrouterApiKey: env.OPENROUTER_API_KEY,
    hlAccountAddress: env.HL_ACCOUNT_ADDRESS,
    hlApiWalletPrivateKey: env.HL_API_WALLET_PRIVATE_KEY,
    injPrivateKey: env.INJ_PRIVATE_KEY,
  },
} as const;

export type Config = typeof config;
