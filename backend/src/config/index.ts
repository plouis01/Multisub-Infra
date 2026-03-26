import { z } from "zod";

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().default(3000),
  corsOrigin: z.string().default("http://localhost:5173"),
  nodeEnv: z.string().default("development"),

  // Blockchain
  rpcUrl: z.string().default("https://sepolia.base.org"),
  chainId: z.coerce.number().default(84532),

  // Contract Addresses
  spendSettlerAddress: z.string().default(""),
  m1TreasuryAddress: z.string().default(""),
  platformIssuerSafeAddress: z.string().default(""),
  usdcAddress: z.string().default("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),

  // Keys
  settlerPrivateKey: z.string().default(""),

  // Database
  databaseUrl: z
    .string()
    .default("postgresql://multisubs:multisubs@localhost:5432/multisubs"),

  // Redis
  redisUrl: z.string().default("redis://localhost:6379"),

  // Lithic
  lithicApiKey: z.string().default(""),
  lithicWebhookSecret: z.string().default(""),
  lithicEnvironment: z.enum(["sandbox", "production"]).default("sandbox"),

  // Watcher
  watcherPollIntervalMs: z.coerce.number().default(3000),
  watcherStartBlock: z.coerce.number().default(0),

  // Settlement
  settlementMaxRetries: z.coerce.number().default(3),
  settlementGasBumpPercent: z.coerce.number().default(20),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env.PORT,
    corsOrigin: process.env.CORS_ORIGIN,
    nodeEnv: process.env.NODE_ENV,
    rpcUrl:
      process.env.BASE_SEPOLIA_RPC_URL || process.env.BASE_MAINNET_RPC_URL,
    chainId: process.env.CHAIN_ID,
    spendSettlerAddress: process.env.SPEND_SETTLER_ADDRESS,
    m1TreasuryAddress: process.env.M1_TREASURY_ADDRESS,
    platformIssuerSafeAddress: process.env.PLATFORM_ISSUER_SAFE_ADDRESS,
    usdcAddress: process.env.USDC_ADDRESS,
    settlerPrivateKey: process.env.SETTLER_PRIVATE_KEY,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    lithicApiKey: process.env.LITHIC_API_KEY,
    lithicWebhookSecret: process.env.LITHIC_WEBHOOK_SECRET,
    lithicEnvironment: process.env.LITHIC_ENVIRONMENT,
    watcherPollIntervalMs: process.env.WATCHER_POLL_INTERVAL_MS,
    watcherStartBlock: process.env.WATCHER_START_BLOCK,
    settlementMaxRetries: process.env.SETTLEMENT_MAX_RETRIES,
    settlementGasBumpPercent: process.env.SETTLEMENT_GAS_BUMP_PERCENT,
  });
}
