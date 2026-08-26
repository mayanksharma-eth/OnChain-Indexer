import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { fills, type Fill, type NewFill } from "../schema.js";

/** Idempotent: re-inserting the same (chainId, transactionHash, logIndex) returns the existing row. */
export async function insertFill(db: DbOrTx, values: NewFill): Promise<Fill> {
  const [inserted] = await db
    .insert(fills)
    .values(values)
    .onConflictDoNothing({ target: [fills.chainId, fills.transactionHash, fills.logIndex] })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(fills)
    .where(
      and(eq(fills.chainId, values.chainId), eq(fills.transactionHash, values.transactionHash), eq(fills.logIndex, values.logIndex)),
    );
  if (!existing) throw new Error("failed to insert fill");
  return existing;
}

/** Reorg support: deletes fills recorded at or above `fromBlockNumber` — they came from
 * blocks that are no longer canonical. */
export async function deleteFillsFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<Fill[]> {
  return db
    .delete(fills)
    .where(and(eq(fills.chainId, chainId), gte(fills.blockNumber, fromBlockNumber)))
    .returning();
}

export async function listFillsByIntent(
  db: DbOrTx,
  chainId: number,
  intentId: string,
): Promise<Fill[]> {
  return db
    .select()
    .from(fills)
    .where(and(eq(fills.chainId, chainId), eq(fills.intentId, intentId)))
    .orderBy(asc(fills.id));
}

export async function countFills(db: DbOrTx, chainId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(fills)
    .where(eq(fills.chainId, chainId));
  return Number(row?.count ?? 0);
}
