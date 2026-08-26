import { and, desc, eq, gte } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { blocks, type Block, type NewBlock } from "../schema.js";

/** Idempotent: re-inserting the same (chainId, blockNumber, blockHash) returns the existing row. */
export async function insertBlock(db: DbOrTx, values: NewBlock): Promise<Block> {
  const [inserted] = await db
    .insert(blocks)
    .values(values)
    .onConflictDoNothing({ target: [blocks.chainId, blocks.blockNumber, blocks.blockHash] })
    .returning();
  if (inserted) return inserted;

  const existing = await getBlockByHash(db, values.chainId, values.blockHash);
  if (!existing) throw new Error("failed to insert block");
  return existing;
}

export async function getBlock(
  db: DbOrTx,
  chainId: number,
  blockNumber: number,
): Promise<Block | undefined> {
  const [row] = await db
    .select()
    .from(blocks)
    .where(
      and(eq(blocks.chainId, chainId), eq(blocks.blockNumber, blockNumber), eq(blocks.isCanonical, true)),
    );
  return row;
}

export async function getBlockByHash(
  db: DbOrTx,
  chainId: number,
  blockHash: string,
): Promise<Block | undefined> {
  const [row] = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.chainId, chainId), eq(blocks.blockHash, blockHash)));
  return row;
}

export async function getLatestBlock(db: DbOrTx, chainId: number): Promise<Block | undefined> {
  const [row] = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.chainId, chainId), eq(blocks.isCanonical, true)))
    .orderBy(desc(blocks.blockNumber))
    .limit(1);
  return row;
}

/** Reorg support: flips every canonical block at or above `fromBlockNumber` to non-canonical. */
export async function markNonCanonical(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<Block[]> {
  return db
    .update(blocks)
    .set({ isCanonical: false })
    .where(
      and(eq(blocks.chainId, chainId), gte(blocks.blockNumber, fromBlockNumber), eq(blocks.isCanonical, true)),
    )
    .returning();
}
