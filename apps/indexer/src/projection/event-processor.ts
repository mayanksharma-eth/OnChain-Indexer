import type { DbOrTx, Fill, Intent } from "@onchain-indexer/database";
import type { DecodedIntentEvent } from "../decoder/events.js";
import { processIntentCancelled, processIntentCreated, processIntentFilled } from "./processors.js";

export type ProjectionResult =
  | { eventName: "IntentCreated"; intent: Intent }
  | { eventName: "IntentCancelled"; intent: Intent }
  | { eventName: "IntentFilled"; intent: Intent; fill: Fill }
  | { eventName: "ignored" };

/**
 * Dispatches one decoded event to its domain processor. Every write happens through `tx`, so
 * callers running this inside their own transaction get atomicity with whatever else they write
 * in that transaction (e.g. the raw event row).
 *
 * Events outside the known intent lifecycle (any decoded event this switch doesn't recognize)
 * are ignored here — they're still persisted to the immutable raw events table by the caller,
 * just not projected into domain state.
 */
export async function processDecodedEvent(
  tx: DbOrTx,
  chainId: number,
  event: DecodedIntentEvent,
): Promise<ProjectionResult> {
  switch (event.eventName) {
    case "IntentCreated":
      return { eventName: "IntentCreated", intent: await processIntentCreated(tx, chainId, event) };
    case "IntentCancelled":
      return { eventName: "IntentCancelled", intent: await processIntentCancelled(tx, chainId, event) };
    case "IntentFilled": {
      const { intent, fill } = await processIntentFilled(tx, chainId, event);
      return { eventName: "IntentFilled", intent, fill };
    }
    default:
      return { eventName: "ignored" };
  }
}
