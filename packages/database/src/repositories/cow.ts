import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import {
  cowOrderEvents,
  cowSettlements,
  cowTrades,
  type CowOrderEvent,
  type CowSettlement,
  type CowTrade,
  type NewCowOrderEvent,
  type NewCowSettlement,
  type NewCowTrade,
} from "../schema.js";

/** Idempotent: re-inserting the same (chainId, transactionHash) returns the existing row — a
 * transaction calls `settle()` at most once. */
export async function insertCowSettlement(db: DbOrTx, values: NewCowSettlement): Promise<CowSettlement> {
  const [inserted] = await db
    .insert(cowSettlements)
    .values(values)
    .onConflictDoNothing({ target: [cowSettlements.chainId, cowSettlements.transactionHash] })
    .returning();
  if (inserted) return inserted;

  const existing = await getCowSettlementByTxHash(db, values.chainId, values.transactionHash);
  if (!existing) throw new Error("failed to insert cow settlement");
  return existing;
}

export async function getCowSettlementByTxHash(
  db: DbOrTx,
  chainId: number,
  transactionHash: string,
): Promise<CowSettlement | undefined> {
  const [row] = await db
    .select()
    .from(cowSettlements)
    .where(and(eq(cowSettlements.chainId, chainId), eq(cowSettlements.transactionHash, transactionHash)));
  return row;
}

/** Reorg support: deletes settlements recorded at or above `fromBlockNumber` — delete before
 * `deleteCowTradesFromBlock` is unnecessary (no cascade), but call both together since they come
 * from the same reorged range. */
export async function deleteCowSettlementsFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<CowSettlement[]> {
  return db
    .delete(cowSettlements)
    .where(and(eq(cowSettlements.chainId, chainId), gte(cowSettlements.blockNumber, fromBlockNumber)))
    .returning();
}

export interface ListCowSettlementsFilters {
  solver?: string;
  fromBlock?: number;
  toBlock?: number;
  cursor?: number;
  limit: number;
}

export async function listCowSettlements(
  db: DbOrTx,
  chainId: number,
  filters: ListCowSettlementsFilters,
): Promise<CowSettlement[]> {
  const conditions = [eq(cowSettlements.chainId, chainId)];
  if (filters.solver) conditions.push(eq(cowSettlements.solver, filters.solver));
  if (filters.fromBlock !== undefined) conditions.push(gte(cowSettlements.blockNumber, filters.fromBlock));
  if (filters.toBlock !== undefined) conditions.push(sql`${cowSettlements.blockNumber} <= ${filters.toBlock}`);
  if (filters.cursor !== undefined) conditions.push(gt(cowSettlements.id, filters.cursor));

  return db
    .select()
    .from(cowSettlements)
    .where(and(...conditions))
    .orderBy(asc(cowSettlements.id))
    .limit(filters.limit);
}

export async function countCowSettlements(db: DbOrTx, chainId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(cowSettlements)
    .where(eq(cowSettlements.chainId, chainId));
  return Number(row?.count ?? 0);
}

/** Most active solvers by settlement count, descending. Source of "most active solvers" /
 * "recent solver activity" — solver identity and volume are exactly what's derivable from
 * `Settlement(address indexed solver)`; nothing here is inferred beyond the indexed events. */
export async function topCowSolvers(
  db: DbOrTx,
  chainId: number,
  limit: number,
): Promise<{ solver: string; settlementCount: number }[]> {
  const rows = await db
    .select({ solver: cowSettlements.solver, count: sql<string>`count(*)` })
    .from(cowSettlements)
    .where(eq(cowSettlements.chainId, chainId))
    .groupBy(cowSettlements.solver)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows.map((row) => ({ solver: row.solver, settlementCount: Number(row.count) }));
}

/** Idempotent: re-inserting the same (chainId, transactionHash, logIndex) returns the existing row. */
export async function insertCowTrade(db: DbOrTx, values: NewCowTrade): Promise<CowTrade> {
  const [inserted] = await db
    .insert(cowTrades)
    .values(values)
    .onConflictDoNothing({ target: [cowTrades.chainId, cowTrades.transactionHash, cowTrades.logIndex] })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(cowTrades)
    .where(
      and(
        eq(cowTrades.chainId, values.chainId),
        eq(cowTrades.transactionHash, values.transactionHash),
        eq(cowTrades.logIndex, values.logIndex),
      ),
    );
  if (!existing) throw new Error("failed to insert cow trade");
  return existing;
}

/** Reorg support: deletes trades recorded at or above `fromBlockNumber`. Must run before the
 * settlement rows they FK to are deleted. */
export async function deleteCowTradesFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<CowTrade[]> {
  return db
    .delete(cowTrades)
    .where(and(eq(cowTrades.chainId, chainId), gte(cowTrades.blockNumber, fromBlockNumber)))
    .returning();
}

export interface ListCowTradesFilters {
  owner?: string;
  orderUid?: string;
  transactionHash?: string;
  fromBlock?: number;
  toBlock?: number;
  cursor?: number;
  limit: number;
}

export async function listCowTrades(
  db: DbOrTx,
  chainId: number,
  filters: ListCowTradesFilters,
): Promise<CowTrade[]> {
  const conditions = [eq(cowTrades.chainId, chainId)];
  if (filters.owner) conditions.push(eq(cowTrades.owner, filters.owner));
  if (filters.orderUid) conditions.push(eq(cowTrades.orderUid, filters.orderUid));
  if (filters.transactionHash) conditions.push(eq(cowTrades.transactionHash, filters.transactionHash));
  if (filters.fromBlock !== undefined) conditions.push(gte(cowTrades.blockNumber, filters.fromBlock));
  if (filters.toBlock !== undefined) conditions.push(sql`${cowTrades.blockNumber} <= ${filters.toBlock}`);
  if (filters.cursor !== undefined) conditions.push(gt(cowTrades.id, filters.cursor));

  return db
    .select()
    .from(cowTrades)
    .where(and(...conditions))
    .orderBy(asc(cowTrades.id))
    .limit(filters.limit);
}

export async function countCowTrades(db: DbOrTx, chainId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(cowTrades)
    .where(eq(cowTrades.chainId, chainId));
  return Number(row?.count ?? 0);
}

/** Idempotent: re-inserting the same (chainId, transactionHash, logIndex) returns the existing row. */
export async function insertCowOrderEvent(db: DbOrTx, values: NewCowOrderEvent): Promise<CowOrderEvent> {
  const [inserted] = await db
    .insert(cowOrderEvents)
    .values(values)
    .onConflictDoNothing({ target: [cowOrderEvents.chainId, cowOrderEvents.transactionHash, cowOrderEvents.logIndex] })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(cowOrderEvents)
    .where(
      and(
        eq(cowOrderEvents.chainId, values.chainId),
        eq(cowOrderEvents.transactionHash, values.transactionHash),
        eq(cowOrderEvents.logIndex, values.logIndex),
      ),
    );
  if (!existing) throw new Error("failed to insert cow order event");
  return existing;
}

/** Reorg support: deletes order-invalidation events recorded at or above `fromBlockNumber`. */
export async function deleteCowOrderEventsFromBlock(
  db: DbOrTx,
  chainId: number,
  fromBlockNumber: number,
): Promise<CowOrderEvent[]> {
  return db
    .delete(cowOrderEvents)
    .where(and(eq(cowOrderEvents.chainId, chainId), gte(cowOrderEvents.blockNumber, fromBlockNumber)))
    .returning();
}

export async function listCowOrderEventsByOrderUid(
  db: DbOrTx,
  chainId: number,
  orderUid: string,
): Promise<CowOrderEvent[]> {
  return db
    .select()
    .from(cowOrderEvents)
    .where(and(eq(cowOrderEvents.chainId, chainId), eq(cowOrderEvents.orderUid, orderUid)))
    .orderBy(asc(cowOrderEvents.id));
}
