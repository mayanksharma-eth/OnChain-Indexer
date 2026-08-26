import { and, eq, gte } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { events, type Event, type NewEvent } from "../schema.js";

/** Idempotent: re-inserting the same (chainId, transactionHash, logIndex) returns the existing row. */
export async function insertEvent(db: DbOrTx, values: NewEvent): Promise<Event> {
  const [inserted] = await db
    .insert(events)
    .values(values)
    .onConflictDoNothing({ target: [events.chainId, events.transactionHash, events.logIndex] })
    .returning();
  if (inserted) return inserted;

  const existing = await getEvent(db, values.chainId, values.transactionHash, values.logIndex);
  if (!existing) throw new Error("failed to insert event");
  return existing;
}

export async function getEvent(
  db: DbOrTx,
  chainId: number,
  transactionHash: string,
  logIndex: number,
): Promise<Event | undefined> {
  const [row] = await db
    .select()
    .from(events)
    .where(
      and(eq(events.chainId, chainId), eq(events.transactionHash, transactionHash), eq(events.logIndex, logIndex)),
    );
  return row;
}

export async function eventExists(
  db: DbOrTx,
  chainId: number,
  transactionHash: string,
  logIndex: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(eq(events.chainId, chainId), eq(events.transactionHash, transactionHash), eq(events.logIndex, logIndex)),
    )
    .limit(1);
  return row !== undefined;
}

/** Reorg support: flips every canonical event at or above `fromBlockNumber` to non-canonical. */
export async function markEventsNonCanonical(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<Event[]> {
  return db
    .update(events)
    .set({ isCanonical: false })
    .where(
      and(eq(events.chainId, chainId), gte(events.blockNumber, fromBlockNumber), eq(events.isCanonical, true)),
    )
    .returning();
}
