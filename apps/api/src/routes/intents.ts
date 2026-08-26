import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cacheKeys,
  getIntent,
  IntentStatus,
  listFillsByIntent,
  listIntents,
  type Database,
} from "@onchain-indexer/database";
import { AppError, okAtBlock, okListAtBlock, type RedisClient } from "../lib/http.js";
import { getIndexedBlock } from "../lib/indexed-block.js";
import { CACHE_TTL_SECONDS, withCache } from "../lib/cache.js";
import {
  addressSchema,
  cursorSchema,
  DEFAULT_LIMIT,
  intentIdSchema,
  intentStatusSchema,
  limitSchema,
} from "../lib/validation.js";

const listIntentsQuerySchema = z.object({
  status: intentStatusSchema.optional(),
  owner: addressSchema.optional(),
  tokenIn: addressSchema.optional(),
  tokenOut: addressSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const intentIdParamSchema = z.object({ intentId: intentIdSchema });

export interface IntentRouteDeps {
  db: Database;
  chainId: number;
  redis: RedisClient | null;
  nodeEnv: string;
}

/** Only the bare `?status=OPEN` query (no other filters, default page) is cached — that's the
 * one solvers poll repeatedly. Anything more specific goes straight to the DB: keying the cache
 * on every filter/limit/cursor combination isn't worth it for traffic that's mostly one-shot. */
function isCacheableOpenIntentsQuery(query: z.infer<typeof listIntentsQuerySchema>): boolean {
  return (
    query.status === IntentStatus.OPEN &&
    query.owner === undefined &&
    query.tokenIn === undefined &&
    query.tokenOut === undefined &&
    query.cursor === undefined &&
    query.limit === DEFAULT_LIMIT
  );
}

export function registerIntentRoutes(app: FastifyInstance, deps: IntentRouteDeps): void {
  const { db, chainId, redis, nodeEnv } = deps;

  app.get("/intents", async (request) => {
    const query = listIntentsQuerySchema.parse(request.query);

    const fetchIntents = async () => {
      const indexedBlock = await getIndexedBlock(db, chainId);
      const rows = await listIntents(db, chainId, query);
      const nextCursor = rows.length === query.limit ? String(rows[rows.length - 1]!.id) : null;
      return { rows, indexedBlock, nextCursor };
    };

    const { rows, indexedBlock, nextCursor } = isCacheableOpenIntentsQuery(query)
      ? await withCache({ redis, nodeEnv }, cacheKeys.openIntents(chainId), CACHE_TTL_SECONDS.openIntents, fetchIntents)
      : await fetchIntents();

    return okListAtBlock(rows, indexedBlock, nextCursor);
  });

  app.get("/intents/:intentId", async (request) => {
    const { intentId } = intentIdParamSchema.parse(request.params);

    const indexedBlock = await getIndexedBlock(db, chainId);
    const intent = await getIntent(db, chainId, intentId);
    if (!intent) throw new AppError(404, `intent not found: ${intentId}`, "intent_not_found");

    return okAtBlock(intent, indexedBlock);
  });

  app.get("/intents/:intentId/fills", async (request) => {
    const { intentId } = intentIdParamSchema.parse(request.params);

    const indexedBlock = await getIndexedBlock(db, chainId);
    const intent = await getIntent(db, chainId, intentId);
    if (!intent) throw new AppError(404, `intent not found: ${intentId}`, "intent_not_found");
    const fills = await listFillsByIntent(db, chainId, intentId);

    return okAtBlock(fills, indexedBlock);
  });
}
