import { loadIndexerConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";
import { createDb, createRedis } from "@onchain-indexer/database";
import { createRpcClient } from "./rpc/index.js";
import { runCowIndexerLoop } from "./loop/index.js";
import { indexerStatus } from "./status/index.js";

/**
 * CoW Protocol adapter entry point — same generic ingestion/checkpoint/reorg machinery as
 * index.ts (the intent-protocol demo), pointed at the CoW GPv2Settlement decoder/projection
 * instead. Run this as a separate process from index.ts, with CONTRACT_ADDRESS set to CoW's
 * settlement contract (0x9008D19f58AAbD9eD0D60971565AA8510560ab41 — the same address on every
 * supported chain). Checkpoints under a distinct indexerName ("cow-events") so it can run
 * against the same chainId/Postgres as the intent indexer without the two streams colliding —
 * see packages/database's indexer_checkpoints, keyed (chainId, indexerName).
 */
const INDEXER_NAME = "cow-events";

async function main() {
  const config = loadIndexerConfig();
  const db = createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? createRedis(config.REDIS_URL) : null;
  const client = await createRpcClient({
    rpcUrl: config.RPC_URL,
    chainId: config.CHAIN_ID,
    contractAddress: config.CONTRACT_ADDRESS,
  });

  const controller = new AbortController();
  const requestShutdown = (signal: string) => {
    if (controller.signal.aborted) return;
    logger.info("shutdown requested, finishing current cycle then exiting", { signal });
    controller.abort();
  };
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));

  try {
    await runCowIndexerLoop({
      client,
      db,
      redis,
      chainId: config.CHAIN_ID,
      indexerName: INDEXER_NAME,
      startBlock: config.INDEXER_START_BLOCK,
      chunkSize: config.INDEXER_CHUNK_SIZE,
      confirmations: config.CONFIRMATIONS,
      pollIntervalMs: config.INDEXER_POLL_INTERVAL_MS,
      signal: controller.signal,
    });
  } finally {
    logger.info("final cow indexer status", { ...indexerStatus.getSnapshot() });
    await db.$client.end();
    await redis?.quit();
    logger.info("shut down cleanly");
  }
}

main().catch((error: unknown) => {
  logger.error("cow indexer failed", { error: String(error) });
  process.exit(1);
});
