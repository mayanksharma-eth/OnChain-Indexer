import { getBlock, markEventsNonCanonical, markNonCanonical, type Database } from "@onchain-indexer/database";
import { indexerReorgsTotal, logger } from "@onchain-indexer/utils";
import type { RpcClient } from "../rpc/client.js";
import { advanceCheckpoint } from "../checkpoint/checkpoint-service.js";
import { rollbackProjectionsFromBlock } from "../projection/rollback.js";

/** Bounded reorg handling only looks this many blocks back for a common ancestor. A reorg
 * deeper than this is treated as unrecoverable — see ReorgTooDeepError. */
export const MAX_REORG_DEPTH = 20;

export class ReorgTooDeepError extends Error {
  constructor(chainId: number, maxDepth: number) {
    super(
      `reorg on chain ${chainId} exceeds MAX_REORG_DEPTH (${maxDepth}); no common ancestor found. Indexing halted.`,
    );
    this.name = "ReorgTooDeepError";
  }
}

export interface ReorgResult {
  ancestorBlock: number;
  ancestorBlockHash: string;
  affectedFrom: number;
}

/**
 * Walks backward from `fromBlockNumber` comparing the chain's current view of each block
 * (via RPC) against what's stored locally as canonical, until it finds a block both agree on
 * — the common ancestor — or exceeds MAX_REORG_DEPTH. A height with no local record at all is
 * also treated as an ancestor (nothing there to disagree with).
 */
async function findCommonAncestor(
  db: Database,
  client: RpcClient,
  chainId: number,
  fromBlockNumber: number,
): Promise<{ blockNumber: number; blockHash: string }> {
  for (let depth = 1; depth <= MAX_REORG_DEPTH; depth++) {
    const blockNumber = fromBlockNumber - depth;
    const remote = await client.getBlock(blockNumber);
    if (remote.hash === null) throw new Error(`ancestor candidate block ${blockNumber} has no hash (pending block?)`);

    const local = await getBlock(db, chainId, blockNumber);
    if (!local || local.blockHash === remote.hash) {
      return { blockNumber, blockHash: remote.hash };
    }
  }
  throw new ReorgTooDeepError(chainId, MAX_REORG_DEPTH);
}

/**
 * Handles a detected reorg for one (chainId, indexerName) stream:
 *  1. finds the common ancestor by walking back from `divergentBlockNumber`
 *  2. marks every block/event at or above the ancestor non-canonical
 *  3. rolls back domain projections derived from those events
 *  4. restores the checkpoint to the ancestor
 * all in one transaction. Re-fetching the new canonical blocks and replaying their events back
 * onto the checkpoint is the caller's job — it's just a normal indexing pass starting at
 * `affectedFrom` (see runIndexingPipeline), no separate replay machinery needed.
 */
export async function handleReorg(
  db: Database,
  client: RpcClient,
  chainId: number,
  indexerName: string,
  divergentBlockNumber: number,
): Promise<ReorgResult> {
  const ancestor = await findCommonAncestor(db, client, chainId, divergentBlockNumber);
  const affectedFrom = ancestor.blockNumber + 1;

  logger.warn("REORG DETECTED", { chainId, indexerName, divergentBlockNumber, ancestorBlock: ancestor.blockNumber });
  indexerReorgsTotal.inc({ chain_id: chainId });

  await db.transaction(async (tx) => {
    const blocks = await markNonCanonical(tx, chainId, affectedFrom);
    const events = await markEventsNonCanonical(tx, chainId, affectedFrom);
    await rollbackProjectionsFromBlock(tx, chainId, affectedFrom);
    await advanceCheckpoint(
      tx,
      { chainId, indexerName },
      { blockNumber: ancestor.blockNumber, blockHash: ancestor.blockHash },
    );
    logger.warn("reorg rollback complete", {
      chainId,
      indexerName,
      affectedFrom,
      blocksMarkedNonCanonical: blocks.length,
      eventsMarkedNonCanonical: events.length,
      checkpointRestoredTo: ancestor.blockNumber,
    });
  });

  return { ancestorBlock: ancestor.blockNumber, ancestorBlockHash: ancestor.blockHash, affectedFrom };
}
