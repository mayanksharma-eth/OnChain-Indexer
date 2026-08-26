import { getCheckpoint, type Database } from "@onchain-indexer/database";
import { INDEXER_NAME } from "./http.js";

/** The block up to which this chain's data is known-consistent — the same value the indexer
 * loop commits to indexer_checkpoints alongside the domain rows it writes (see
 * apps/indexer/src/pipeline/persist.ts). Null if nothing has been indexed yet.
 *
 * Read this BEFORE querying domain data in a handler, not after: reading it first only ever
 * understates freshness (a concurrent commit between the two reads can't be observed by the
 * later checkpoint read), never overstates it — so the response never claims a block newer than
 * what the returned rows might actually reflect. */
export async function getIndexedBlock(db: Database, chainId: number): Promise<number | null> {
  const checkpoint = await getCheckpoint(db, chainId, INDEXER_NAME);
  return checkpoint?.lastProcessedBlock ?? null;
}
