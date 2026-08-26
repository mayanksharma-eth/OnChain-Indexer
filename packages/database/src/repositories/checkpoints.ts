import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { indexerCheckpoints, type IndexerCheckpoint, type NewIndexerCheckpoint } from "../schema.js";

export async function getCheckpoint(
  db: DbOrTx,
  chainId: number,
  indexerName: string,
): Promise<IndexerCheckpoint | undefined> {
  const [row] = await db
    .select()
    .from(indexerCheckpoints)
    .where(and(eq(indexerCheckpoints.chainId, chainId), eq(indexerCheckpoints.indexerName, indexerName)));
  return row;
}

export async function saveCheckpoint(
  db: DbOrTx,
  values: NewIndexerCheckpoint,
): Promise<IndexerCheckpoint> {
  const [row] = await db
    .insert(indexerCheckpoints)
    .values(values)
    .onConflictDoUpdate({
      target: [indexerCheckpoints.chainId, indexerCheckpoints.indexerName],
      set: {
        lastProcessedBlock: values.lastProcessedBlock,
        lastProcessedBlockHash: values.lastProcessedBlockHash,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to save checkpoint");
  return row;
}
