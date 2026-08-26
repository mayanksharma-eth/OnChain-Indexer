import { loadIndexerConfig } from "@onchain-indexer/config";
import { logger } from "@onchain-indexer/utils";

const config = loadIndexerConfig();

// Indexing not implemented yet — this is scaffolding only.
logger.info("indexer placeholder: no indexing logic yet", {
  chainId: config.CHAIN_ID,
  startBlock: config.INDEXER_START_BLOCK,
});
