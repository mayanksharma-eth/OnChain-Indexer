import type { Redis } from "ioredis";

const CACHE_KEY_PREFIX = "cache:v1";

/** Key names shared between the API (reads/writes them) and the indexer (deletes them after a
 * successful write) — both must agree on these or invalidation silently misses. */
export const cacheKeys = {
  solverState: (chainId: number) => `${CACHE_KEY_PREFIX}:solver:state:${chainId}`,
  openIntents: (chainId: number) => `${CACHE_KEY_PREFIX}:intents:open:${chainId}`,
  indexerStatus: (chainId: number) => `${CACHE_KEY_PREFIX}:indexer:status:${chainId}`,
};

export type CacheLogger = (event: "hit" | "miss", key: string) => void;

/**
 * Cache-aside read-through: try Redis, fall back to `fetcher` (the source of truth) on a miss or
 * any Redis failure. Redis is never authoritative — every failure mode here degrades to calling
 * `fetcher` rather than erroring, and a successful lookup is always written back with `ttlSeconds`
 * so a value is never served stale beyond that bound even if invalidation is missed.
 */
export async function cached<T>(
  redis: Redis | null,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  onLog?: CacheLogger,
): Promise<T> {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw !== null) {
        onLog?.("hit", key);
        return JSON.parse(raw) as T;
      }
    } catch {
      // Redis unreachable/erroring — treat as a miss and fall through to the source of truth.
    }
    onLog?.("miss", key);
  }

  const value = await fetcher();

  if (redis) {
    redis.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => {
      // Best-effort write-back; a failed cache write never fails the request.
    });
  }

  return value;
}

/** Deletes the cached endpoints for one chain after a successful indexer write. Never throws — a
 * Redis outage here must not stop indexing; the per-key TTL in `cached` bounds staleness anyway. */
export async function invalidateChainCache(redis: Redis | null, chainId: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(cacheKeys.solverState(chainId), cacheKeys.openIntents(chainId), cacheKeys.indexerStatus(chainId));
  } catch {
    // best-effort
  }
}
