import {
  deleteFillsFromBlock,
  deleteIntentsFromBlock,
  reopenIntentsUpdatedFromBlock,
  type DbOrTx,
} from "@onchain-indexer/database";

/**
 * Reorg support: undoes domain projection state derived from events at or above
 * `fromBlockNumber`. Order matters — fills are deleted before intents they reference (FK), and
 * before reopening intents whose fill/cancel came from the reorged range.
 */
export async function rollbackProjectionsFromBlock(
  tx: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<void> {
  await deleteFillsFromBlock(tx, chainId, fromBlockNumber);
  await deleteIntentsFromBlock(tx, chainId, fromBlockNumber);
  await reopenIntentsUpdatedFromBlock(tx, chainId, fromBlockNumber);
}
