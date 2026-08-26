import { createDb, createRedis } from "@onchain-indexer/database";
import { loadApiConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";
import { buildApp } from "./app.js";
import type { AppState } from "./lib/http.js";

const API_HOST = "0.0.0.0";

async function main() {
  const config = loadApiConfig();
  const db = createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? createRedis(config.REDIS_URL) : null;
  const state: AppState = { initialized: false };

  const app = buildApp({
    db,
    redis,
    logLevel: config.LOG_LEVEL,
    state,
    chainId: config.CHAIN_ID,
    nodeEnv: config.NODE_ENV,
  });

  const shutdown = async (signal: string) => {
    logger.info("shutdown requested", { signal });
    await app.close();
    await db.$client.end();
    await redis?.quit();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.ready();
  state.initialized = true;

  await app.listen({ port: config.API_PORT, host: API_HOST });
  logger.info("api listening", { port: config.API_PORT });
}

main().catch((error: unknown) => {
  logger.error("failed to start api", { error: String(error) });
  process.exit(1);
});
