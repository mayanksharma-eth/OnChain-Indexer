import {
  createIntent,
  getIntent,
  insertFill,
  listFillsByIntent,
  updateIntentStatus,
  IntentStatus,
  type DbOrTx,
  type Fill,
  type Intent,
} from "@onchain-indexer/database";
import type {
  IntentCancelledEvent,
  IntentCreatedEvent,
  IntentFilledEvent,
  RawLogMeta,
} from "../decoder/events.js";
import { ProjectionError } from "./errors.js";

function requireBlockMeta(
  eventName: string,
  raw: RawLogMeta,
): { blockNumber: number; transactionHash: string; logIndex: number } {
  if (raw.blockNumber === null || raw.transactionHash === null || raw.logIndex === null) {
    throw new Error(`${eventName} log is missing block metadata (pending/removed log?)`);
  }
  return {
    blockNumber: Number(raw.blockNumber),
    transactionHash: raw.transactionHash,
    logIndex: raw.logIndex,
  };
}

/** IntentCreated -> create the intent, OPEN. Idempotent: replaying the same IntentCreated
 * returns the existing row (see createIntent's onConflictDoNothing). */
export async function processIntentCreated(
  tx: DbOrTx,
  chainId: number,
  event: IntentCreatedEvent,
): Promise<Intent> {
  const { blockNumber, transactionHash } = requireBlockMeta(event.eventName, event.raw);
  const { deadline } = event.args;
  // `deadline` is a uint256 on-chain but stored as a plain number (it's meant to hold a unix
  // timestamp). A contract that emits something outside the safe-integer range — malicious or
  // buggy — would otherwise silently lose precision or overflow into Infinity on insert. Reject
  // it explicitly instead: the surrounding transaction rolls back (see pipeline/persist.ts) and
  // the range is retried next poll rather than persisting a corrupted deadline.
  if (deadline < 0n || deadline > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProjectionError(
      `IntentCreated ${event.args.intentId} has an out-of-range deadline (${deadline.toString()})`,
    );
  }
  return createIntent(tx, {
    chainId,
    intentId: event.args.intentId,
    owner: event.args.owner,
    tokenIn: event.args.tokenIn,
    tokenOut: event.args.tokenOut,
    amountIn: event.args.amountIn.toString(),
    minAmountOut: event.args.minAmountOut.toString(),
    deadline: Number(deadline),
    status: IntentStatus.OPEN,
    createdBlock: blockNumber,
    createdTxHash: transactionHash,
  });
}

/** IntentCancelled -> status CANCELLED. OPEN is the only valid source status; CANCELLED is
 * terminal so a replayed event is a no-op. Throws ProjectionError if the intent doesn't exist
 * (event arrived before its IntentCreated) or is already FILLED (invalid transition). */
export async function processIntentCancelled(
  tx: DbOrTx,
  chainId: number,
  event: IntentCancelledEvent,
): Promise<Intent> {
  const { blockNumber, transactionHash } = requireBlockMeta(event.eventName, event.raw);
  const { intentId } = event.args;

  const existing = await getIntent(tx, chainId, intentId);
  if (!existing) {
    throw new ProjectionError(
      `cannot cancel intent ${intentId}: no matching IntentCreated seen (event out of order?)`,
    );
  }
  if (existing.status === IntentStatus.CANCELLED) return existing;
  if (existing.status !== IntentStatus.OPEN) {
    throw new ProjectionError(
      `invalid transition: intent ${intentId} is ${existing.status}, cannot cancel`,
    );
  }

  const updated = await updateIntentStatus(tx, chainId, intentId, {
    status: IntentStatus.CANCELLED,
    updatedBlock: blockNumber,
    updatedTxHash: transactionHash,
  });
  if (!updated) throw new Error(`failed to cancel intent ${intentId}`);
  return updated;
}

/** IntentFilled -> create the fill, status FILLED. OPEN is the only valid source status.
 * A replayed fill event (same tx/logIndex) on an already-FILLED intent is idempotent; a
 * second, different fill on an already-FILLED intent is an invalid transition. Throws
 * ProjectionError if the intent doesn't exist yet or is CANCELLED. */
export async function processIntentFilled(
  tx: DbOrTx,
  chainId: number,
  event: IntentFilledEvent,
): Promise<{ intent: Intent; fill: Fill }> {
  const { blockNumber, transactionHash, logIndex } = requireBlockMeta(event.eventName, event.raw);
  const { intentId } = event.args;

  const existing = await getIntent(tx, chainId, intentId);
  if (!existing) {
    throw new ProjectionError(
      `cannot fill intent ${intentId}: no matching IntentCreated seen (event out of order?)`,
    );
  }
  if (existing.status === IntentStatus.FILLED) {
    const priorFills = await listFillsByIntent(tx, chainId, intentId);
    const duplicate = priorFills.find(
      (f) => f.transactionHash === transactionHash && f.logIndex === logIndex,
    );
    if (duplicate) return { intent: existing, fill: duplicate };
    throw new ProjectionError(
      `invalid transition: intent ${intentId} is already FILLED, cannot apply a second fill`,
    );
  }
  if (existing.status !== IntentStatus.OPEN) {
    throw new ProjectionError(
      `invalid transition: intent ${intentId} is ${existing.status}, cannot fill`,
    );
  }

  const fill = await insertFill(tx, {
    chainId,
    intentId,
    solver: event.args.solver,
    amountIn: event.args.amountIn.toString(),
    amountOut: event.args.amountOut.toString(),
    blockNumber,
    transactionHash,
    logIndex,
  });
  const intent = await updateIntentStatus(tx, chainId, intentId, {
    status: IntentStatus.FILLED,
    updatedBlock: blockNumber,
    updatedTxHash: transactionHash,
  });
  if (!intent) throw new Error(`failed to mark intent ${intentId} as filled`);
  return { intent, fill };
}
