import { getCheckpoint, saveCheckpoint, type Database, type DbOrTx } from "@onchain-indexer/database";

export interface CheckpointIdentity {
  chainId: number;
  indexerName: string;
}

export interface CheckpointValue {
  blockNumber: number;
  blockHash: string;
}

/** Startup recovery: resume after the last saved checkpoint, or from startBlock if this
 * (chainId, indexerName) has never checkpointed before. */
export async function loadStartBlock(
  db: Database,
  identity: CheckpointIdentity,
  startBlock: number,
): Promise<number> {
  const checkpoint = await getCheckpoint(db, identity.chainId, identity.indexerName);
  return checkpoint ? checkpoint.lastProcessedBlock + 1 : startBlock;
}

/**
 * Advances the checkpoint. Callers MUST run this inside the same transaction as the range's
 * writes (see persistFetchedRange) — that's what guarantees the checkpoint only advances once
 * that range's data has actually committed. A range that fails partway rolls the whole
 * transaction back, checkpoint included.
 */
export async function advanceCheckpoint(tx: DbOrTx, identity: CheckpointIdentity, value: CheckpointValue): Promise<void> {
  await saveCheckpoint(tx, {
    chainId: identity.chainId,
    indexerName: identity.indexerName,
    lastProcessedBlock: value.blockNumber,
    lastProcessedBlockHash: value.blockHash,
  });
}
