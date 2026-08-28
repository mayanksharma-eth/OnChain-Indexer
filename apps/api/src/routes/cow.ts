import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cacheKeys,
  countCowSettlements,
  countCowTrades,
  getCowSettlementByTxHash,
  listCowSettlements,
  listCowTrades,
  topCowSolvers,
  type Database,
} from "@onchain-indexer/database";
import { AppError, COW_INDEXER_NAME, okAtBlock, okListAtBlock, type RedisClient } from "../lib/http.js";
import { getIndexedBlock } from "../lib/indexed-block.js";
import { CACHE_TTL_SECONDS, withCache } from "../lib/cache.js";
import { addressSchema, blockNumberSchema, cursorSchema, limitSchema, orderUidSchema, txHashSchema } from "../lib/validation.js";

export interface CowRouteDeps {
  db: Database;
  chainId: number;
  redis: RedisClient | null;
  nodeEnv: string;
}

const listSettlementsQuerySchema = z.object({
  solver: addressSchema.optional(),
  fromBlock: blockNumberSchema.optional(),
  toBlock: blockNumberSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const listTradesQuerySchema = z.object({
  owner: addressSchema.optional(),
  orderUid: orderUidSchema.optional(),
  fromBlock: blockNumberSchema.optional(),
  toBlock: blockNumberSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

const txHashParamSchema = z.object({ transactionHash: txHashSchema });
const orderUidParamSchema = z.object({ orderUid: orderUidSchema });
const solverAddressParamSchema = z.object({ address: addressSchema });

export function registerCowRoutes(app: FastifyInstance, deps: CowRouteDeps): void {
  const { db, chainId, redis, nodeEnv } = deps;
  const indexedBlock = () => getIndexedBlock(db, chainId, COW_INDEXER_NAME);

  app.get("/cow/settlements", async (request) => {
    const query = listSettlementsQuerySchema.parse(request.query);
    const block = await indexedBlock();
    const rows = await listCowSettlements(db, chainId, query);
    const nextCursor = rows.length === query.limit ? String(rows[rows.length - 1]!.id) : null;
    return okListAtBlock(rows, block, nextCursor);
  });

  app.get("/cow/settlements/:transactionHash", async (request) => {
    const { transactionHash } = txHashParamSchema.parse(request.params);
    const block = await indexedBlock();
    const settlement = await getCowSettlementByTxHash(db, chainId, transactionHash);
    if (!settlement) throw new AppError(404, `settlement not found: ${transactionHash}`, "settlement_not_found");
    const trades = await listCowTrades(db, chainId, { transactionHash, limit: 100 });
    return okAtBlock({ settlement, trades }, block);
  });

  app.get("/cow/trades", async (request) => {
    const query = listTradesQuerySchema.parse(request.query);
    const block = await indexedBlock();
    const rows = await listCowTrades(db, chainId, query);
    const nextCursor = rows.length === query.limit ? String(rows[rows.length - 1]!.id) : null;
    return okListAtBlock(rows, block, nextCursor);
  });

  app.get("/cow/trades/:orderUid", async (request) => {
    const { orderUid } = orderUidParamSchema.parse(request.params);
    const query = z.object({ limit: limitSchema, cursor: cursorSchema }).parse(request.query);
    const block = await indexedBlock();
    const rows = await listCowTrades(db, chainId, { orderUid, ...query });
    const nextCursor = rows.length === query.limit ? String(rows[rows.length - 1]!.id) : null;
    return okListAtBlock(rows, block, nextCursor);
  });

  app.get("/cow/solvers/:address", async (request) => {
    const { address } = solverAddressParamSchema.parse(request.params);
    const query = z.object({ limit: limitSchema, cursor: cursorSchema }).parse(request.query);
    const block = await indexedBlock();
    const settlements = await listCowSettlements(db, chainId, { solver: address, ...query });
    const nextCursor = settlements.length === query.limit ? String(settlements[settlements.length - 1]!.id) : null;
    return okListAtBlock(settlements, block, nextCursor);
  });

  app.get("/cow/stats", async () => {
    const { data, indexedBlock: block } = await withCache(
      { redis, nodeEnv },
      cacheKeys.cowStats(chainId),
      CACHE_TTL_SECONDS.cowStats,
      async () => {
        const block = await indexedBlock();
        const [totalSettlements, totalTrades, topSolvers] = await Promise.all([
          countCowSettlements(db, chainId),
          countCowTrades(db, chainId),
          topCowSolvers(db, chainId, 10),
        ]);
        return { data: { chainId, totalSettlements, totalTrades, topSolvers }, indexedBlock: block };
      },
    );
    return okAtBlock(data, block);
  });
}
