import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Server (Railway injects PORT)
  PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  // Database
  DATABASE_URL: z.string(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Dynamic.xyz
  DYNAMIC_ENVIRONMENT_ID: z.string().default(''),
  DYNAMIC_PUBLIC_KEY: z.string().default(''),

  // Dynamic Server Wallets (Phase 2A)
  DYNAMIC_API_KEY: z.string().default(''),
  DYNAMIC_SERVER_WALLET_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  // Trading key encryption (Phase 1 — kept for migration, will be removed post-migration)
  TRADING_KEY_ENCRYPTION_KEY: z.string().default('0'.repeat(64)),

  // Phase 2A feature flag: when true, new users get Dynamic Server Wallets
  USE_SERVER_WALLETS: z.coerce.boolean().default(true),

  // Polymarket
  POLYMARKET_CLOB_API_URL: z.string().default('https://clob.polymarket.com'),
  POLYMARKET_GAMMA_API_URL: z.string().default('https://gamma-api.polymarket.com'),
  POLYMARKET_DATA_API_URL: z.string().default('https://data-api.polymarket.com'),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = configSchema.parse(process.env);
  }
  return _config;
}
