import type { CowOrderEvent, CowSettlement, CowTrade, DbOrTx } from "@onchain-indexer/database";
import type { DecodedCowEvent } from "../decoder/cow-events.js";
import { processCowOrderInvalidated, processCowSettlement, processCowTrade } from "./cow-processors.js";

export type CowProjectionResult =
  | { eventName: "Settlement"; settlement: CowSettlement }
  | { eventName: "Trade"; trade: CowTrade }
  | { eventName: "OrderInvalidated"; orderEvent: CowOrderEvent };

/** Dispatches one decoded CoW event to its domain processor — mirrors
 * apps/indexer/src/projection/event-processor.ts for the intent protocol. */
export async function processDecodedCowEvent(
  tx: DbOrTx,
  chainId: number,
  event: DecodedCowEvent,
): Promise<CowProjectionResult> {
  switch (event.eventName) {
    case "Settlement":
      return { eventName: "Settlement", settlement: await processCowSettlement(tx, chainId, event) };
    case "Trade":
      return { eventName: "Trade", trade: await processCowTrade(tx, chainId, event) };
    case "OrderInvalidated":
      return { eventName: "OrderInvalidated", orderEvent: await processCowOrderInvalidated(tx, chainId, event) };
  }
}
