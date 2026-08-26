import type { FastifyInstance } from "fastify";
import { cacheKeys, countFills, countIntentsByStatus, IntentStatus, type Database } from "@onchain-indexer/database";
import { okAtBlock, type RedisClient } from "../lib/http.js";
import { getIndexedBlock } from "../lib/indexed-block.js";
import { CACHE_TTL_SECONDS, withCache } from "../lib/cache.js";

export interface SolverRouteDeps {
  db: Database;
  chainId: number;
  redis: RedisClient | null;
  nodeEnv: string;
}

export function registerSolverRoutes(app: FastifyInstance, deps: SolverRouteDeps): void {
  const { db, chainId, redis, nodeEnv } = deps;

  app.get("/solver/state", async () => {
    const { data, indexedBlock } = await withCache(
      { redis, nodeEnv },
      cacheKeys.solverState(chainId),
      CACHE_TTL_SECONDS.solverState,
      async () => {
        const indexedBlock = await getIndexedBlock(db, chainId);
        const [byStatus, totalFills] = await Promise.all([
          countIntentsByStatus(db, chainId),
          countFills(db, chainId),
        ]);

        return {
          data: {
            chainId,
            openIntents: byStatus[IntentStatus.OPEN] ?? 0,
            filledIntents: byStatus[IntentStatus.FILLED] ?? 0,
            cancelledIntents: byStatus[IntentStatus.CANCELLED] ?? 0,
            totalFills,
          },
          indexedBlock,
        };
      },
    );

    return okAtBlock(data, indexedBlock);
  });
}
