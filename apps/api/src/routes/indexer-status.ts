import type { FastifyInstance } from "fastify";
import { cacheKeys, getCheckpoint, type Database } from "@onchain-indexer/database";
import { INDEXER_NAME, okAtBlock, type RedisClient } from "../lib/http.js";
import { CACHE_TTL_SECONDS, withCache } from "../lib/cache.js";

export interface IndexerStatusRouteDeps {
  db: Database;
  chainId: number;
  redis: RedisClient | null;
  nodeEnv: string;
}

/** DB-backed indexer status: only what's persisted in indexer_checkpoints. Does not report
 * in-process lifecycle state (e.g. BACKFILLING/SYNCING) — that lives in the indexer process's
 * own memory (see apps/indexer/src/status/status-service.ts) and isn't reachable without an
 * RPC-adjacent side channel, which this endpoint must not depend on. */
export function registerIndexerStatusRoutes(app: FastifyInstance, deps: IndexerStatusRouteDeps): void {
  const { db, chainId, redis, nodeEnv } = deps;

  app.get("/indexer/status", async () => {
    const data = await withCache(
      { redis, nodeEnv },
      cacheKeys.indexerStatus(chainId),
      CACHE_TTL_SECONDS.indexerStatus,
      async () => {
        const checkpoint = await getCheckpoint(db, chainId, INDEXER_NAME);
        return {
          chainId,
          indexerName: INDEXER_NAME,
          indexedBlock: checkpoint?.lastProcessedBlock ?? null,
          indexedBlockHash: checkpoint?.lastProcessedBlockHash ?? null,
          updatedAt: checkpoint?.updatedAt.toISOString() ?? null,
        };
      },
    );

    return okAtBlock(data, data.indexedBlock);
  });
}
