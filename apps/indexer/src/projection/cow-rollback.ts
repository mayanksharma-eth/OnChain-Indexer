import {
  deleteCowOrderEventsFromBlock,
  deleteCowSettlementsFromBlock,
  deleteCowTradesFromBlock,
  type DbOrTx,
} from "@onchain-indexer/database";

/**
 * Reorg support for the CoW adapter: deletes projection state derived from events at or above
 * `fromBlockNumber`. Unlike the intent protocol's `intents` table, none of these rows are ever
 * mutated in place after insert (a settlement/trade/order-invalidation is a fact about one
 * transaction, not evolving state) — so rollback here is a pure delete, no reopen/reconcile step
 * needed. Trades are deleted before settlements (FK).
 */
export async function rollbackCowProjectionsFromBlock(
  tx: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<void> {
  await deleteCowTradesFromBlock(tx, chainId, fromBlockNumber);
  await deleteCowSettlementsFromBlock(tx, chainId, fromBlockNumber);
  await deleteCowOrderEventsFromBlock(tx, chainId, fromBlockNumber);
}
