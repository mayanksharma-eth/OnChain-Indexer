import { cached, type CacheLogger } from "@onchain-indexer/database";
import { logger } from "@onchain-indexer/utils";
import type { RedisClient } from "./http.js";

export const CACHE_TTL_SECONDS = {
  solverState: 2,
  openIntents: 2,
  indexerStatus: 1,
} as const;

function devLogger(nodeEnv: string): CacheLogger | undefined {
  if (nodeEnv !== "development") return undefined;
  return (event, key) => logger.debug(`cache ${event}`, { key });
}

export interface CacheDeps {
  redis: RedisClient | null;
  nodeEnv: string;
}

/** Cache-aside wrapper for route handlers: adds dev-only hit/miss logging on top of the shared
 * `cached()` read-through (see packages/database/src/cache.ts for the failure/TTL semantics). */
export function withCache<T>(deps: CacheDeps, key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  return cached(deps.redis, key, ttlSeconds, fetcher, devLogger(deps.nodeEnv));
}
