import {
  insertCowOrderEvent,
  insertCowSettlement,
  insertCowTrade,
  type CowOrderEvent,
  type CowSettlement,
  type CowTrade,
  type DbOrTx,
} from "@onchain-indexer/database";
import type { CowOrderInvalidatedEvent, CowSettlementEvent, CowTradeEvent } from "../decoder/cow-events.js";
import type { RawLogMeta } from "../decoder/events.js";
import { ProjectionError } from "./errors.js";

function requireLogMeta(
  eventName: string,
  raw: RawLogMeta,
): { blockNumber: number; blockHash: string; transactionHash: string; transactionIndex: number; logIndex: number } {
  if (
    raw.blockNumber === null ||
    raw.blockHash === null ||
    raw.transactionHash === null ||
    raw.transactionIndex === null ||
    raw.logIndex === null
  ) {
    throw new ProjectionError(`${eventName} log is missing block metadata (pending/removed log?)`);
  }
  return {
    blockNumber: Number(raw.blockNumber),
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
  };
}

/** Settlement -> one row recording which solver executed this transaction. Idempotent: replaying
 * the same Settlement returns the existing row (see insertCowSettlement's onConflictDoNothing). */
export async function processCowSettlement(
  tx: DbOrTx,
  chainId: number,
  event: CowSettlementEvent,
): Promise<CowSettlement> {
  const meta = requireLogMeta(event.eventName, event.raw);
  return insertCowSettlement(tx, {
    chainId,
    solver: event.args.solver,
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash,
    transactionHash: meta.transactionHash,
    transactionIndex: meta.transactionIndex,
    logIndex: meta.logIndex,
  });
}

/** Trade -> one row per matched order in a settlement's batch. Idempotent on (chainId, txHash,
 * logIndex). Requires the settlement transaction's Settlement event to already be persisted (FK)
 * — callers must persist all Settlement events in a range before any Trade events; see
 * cow-persist.ts, which does this in two passes since onchain Settlement is always emitted last
 * within its transaction (verified against real mainnet data). */
export async function processCowTrade(tx: DbOrTx, chainId: number, event: CowTradeEvent): Promise<CowTrade> {
  const meta = requireLogMeta(event.eventName, event.raw);
  return insertCowTrade(tx, {
    chainId,
    owner: event.args.owner,
    sellToken: event.args.sellToken,
    buyToken: event.args.buyToken,
    sellAmount: event.args.sellAmount.toString(),
    buyAmount: event.args.buyAmount.toString(),
    feeAmount: event.args.feeAmount.toString(),
    orderUid: event.args.orderUid,
    blockNumber: meta.blockNumber,
    transactionHash: meta.transactionHash,
    logIndex: meta.logIndex,
  });
}

/** OrderInvalidated -> one row recording an onchain order cancellation. Idempotent on (chainId,
 * txHash, logIndex). Unrelated to any settlement (no FK). */
export async function processCowOrderInvalidated(
  tx: DbOrTx,
  chainId: number,
  event: CowOrderInvalidatedEvent,
): Promise<CowOrderEvent> {
  const meta = requireLogMeta(event.eventName, event.raw);
  return insertCowOrderEvent(tx, {
    chainId,
    owner: event.args.owner,
    orderUid: event.args.orderUid,
    blockNumber: meta.blockNumber,
    transactionHash: meta.transactionHash,
    logIndex: meta.logIndex,
  });
}
