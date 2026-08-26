import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { intents, IntentStatus, type Intent, type IntentStatusValue, type NewIntent } from "../schema.js";

/** Idempotent: re-creating the same (chainId, intentId) returns the existing row. */
export async function createIntent(db: DbOrTx, values: NewIntent): Promise<Intent> {
  const [inserted] = await db
    .insert(intents)
    .values(values)
    .onConflictDoNothing({ target: [intents.chainId, intents.intentId] })
    .returning();
  if (inserted) return inserted;

  const existing = await getIntent(db, values.chainId, values.intentId);
  if (!existing) throw new Error("failed to create intent");
  return existing;
}

export async function getIntent(
  db: DbOrTx,
  chainId: number,
  intentId: string,
): Promise<Intent | undefined> {
  const [row] = await db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.intentId, intentId)));
  return row;
}

export async function updateIntentStatus(
  db: DbOrTx,
  chainId: number,
  intentId: string,
  update: { status: string; updatedBlock: number; updatedTxHash: string },
): Promise<Intent | undefined> {
  const [row] = await db
    .update(intents)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(intents.chainId, chainId), eq(intents.intentId, intentId)))
    .returning();
  return row;
}

/** Reorg support: deletes intents created at or above `fromBlockNumber` — their IntentCreated
 * event came from a block that's no longer canonical, so the intent never happened. Delete
 * this indexer's fills for the same range first (FK: fills -> intents). */
export async function deleteIntentsFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<Intent[]> {
  return db
    .delete(intents)
    .where(and(eq(intents.chainId, chainId), gte(intents.createdBlock, fromBlockNumber)))
    .returning();
}

/** Reorg support: for intents created before `fromBlockNumber` but last updated (cancelled or
 * filled) at or above it, reverts the update — that transition's event is no longer canonical,
 * so the intent goes back to OPEN as if it never happened. */
export async function reopenIntentsUpdatedFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<Intent[]> {
  return db
    .update(intents)
    .set({ status: IntentStatus.OPEN, updatedBlock: null, updatedTxHash: null, updatedAt: new Date() })
    .where(
      and(
        eq(intents.chainId, chainId),
        gte(intents.updatedBlock, fromBlockNumber),
        lt(intents.createdBlock, fromBlockNumber),
      ),
    )
    .returning();
}

export async function listOpenIntents(db: DbOrTx, chainId: number): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.status, IntentStatus.OPEN)));
}

export async function listIntentsByOwner(
  db: DbOrTx,
  chainId: number,
  owner: string,
): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.owner, owner)));
}

export interface ListIntentsFilters {
  status?: IntentStatusValue;
  owner?: string;
  tokenIn?: string;
  tokenOut?: string;
  /** Return rows with id greater than this (exclusive) — the previous page's last id. */
  cursor?: number;
  limit: number;
}

/** Paginated, filtered intent listing for the solver-facing API. Ordered by `id` ascending
 * (insertion order, monotonic) so cursor pagination is stable even as new rows are inserted. */
export async function listIntents(
  db: DbOrTx,
  chainId: number,
  filters: ListIntentsFilters,
): Promise<Intent[]> {
  const conditions = [eq(intents.chainId, chainId)];
  if (filters.status) conditions.push(eq(intents.status, filters.status));
  if (filters.owner) conditions.push(eq(intents.owner, filters.owner));
  if (filters.tokenIn) conditions.push(eq(intents.tokenIn, filters.tokenIn));
  if (filters.tokenOut) conditions.push(eq(intents.tokenOut, filters.tokenOut));
  if (filters.cursor !== undefined) conditions.push(gt(intents.id, filters.cursor));

  return db
    .select()
    .from(intents)
    .where(and(...conditions))
    .orderBy(asc(intents.id))
    .limit(filters.limit);
}

/** Per-status intent counts for one chain, for the solver state snapshot. Statuses with zero
 * rows are omitted (no group) — callers default missing entries to 0. */
export async function countIntentsByStatus(
  db: DbOrTx,
  chainId: number,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: intents.status, count: sql<string>`count(*)` })
    .from(intents)
    .where(eq(intents.chainId, chainId))
    .groupBy(intents.status);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}
