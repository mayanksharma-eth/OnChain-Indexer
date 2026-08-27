import { loadIndexerConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";
import { createDb, createRedis } from "@onchain-indexer/database";
import { createRpcClient } from "./rpc/index.js";
import { runIndexerLoop } from "./loop/index.js";
import { indexerStatus } from "./status/index.js";

const INDEXER_NAME = "events";

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
    await runIndexerLoop({
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
    logger.info("final indexer status", { ...indexerStatus.getSnapshot() });
    await db.$client.end();
    await redis?.quit();
    logger.info("shut down cleanly");
  }
}

main().catch((error: unknown) => {
  logger.error("indexer failed", { error: String(error) });
  process.exit(1);
});
