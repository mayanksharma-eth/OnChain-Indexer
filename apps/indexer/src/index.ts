import { loadIndexerConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";
import { createDb } from "@onchain-indexer/database";
import { createRpcClient } from "./rpc/index.js";
import { runIndexingPipeline } from "./pipeline/index.js";
import { loadStartBlock } from "./checkpoint/index.js";

const INDEXER_NAME = "events";

async function main() {
  const config = loadIndexerConfig();
  const db = createDb(config.DATABASE_URL);
  const client = await createRpcClient({ rpcUrl: config.RPC_URL, chainId: config.CHAIN_ID });

  let shuttingDown = false;
  const requestShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown requested, finishing current range then exiting");
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const identity = { chainId: config.CHAIN_ID, indexerName: INDEXER_NAME };
    const startBlock = await loadStartBlock(db, identity, config.INDEXER_START_BLOCK);

    const latest = await client.getLatestBlock();
    if (latest.number === null) throw new Error("latest block has no number (pending block?)");
    const endBlock = Number(latest.number) - config.CONFIRMATIONS;

    if (startBlock > endBlock) {
      logger.info("nothing to index yet", { startBlock, endBlock });
      return;
    }

    logger.info("indexing", { chainId: config.CHAIN_ID, startBlock, endBlock });
    for await (const result of runIndexingPipeline(
      client,
      db,
      config.CHAIN_ID,
      startBlock,
      endBlock,
      config.INDEXER_CHUNK_SIZE,
      { indexerName: INDEXER_NAME },
    )) {
      logger.info("indexed range", { ...result });
      if (shuttingDown) break;
    }
  } finally {
    await db.$client.end();
    logger.info("shut down cleanly");
  }
}

main().catch((error: unknown) => {
  logger.error("indexer failed", { error: String(error) });
  process.exit(1);
});
