import type { Address, Hash, Hex, Log } from "viem";

/** Fields carried through unchanged from the source log, for provenance/debugging. */
export interface RawLogMeta {
  address: Address;
  blockHash: Hash | null;
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  transactionIndex: number | null;
  logIndex: number | null;
  removed: boolean;
  /** topics[0] is the event signature hash; kept for persistence without re-touching the ABI. */
  topics: readonly Hex[];
}

export interface IntentCreatedEvent {
  eventName: "IntentCreated";
  args: {
    intentId: Hex;
    owner: Address;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    minAmountOut: bigint;
    deadline: bigint;
  };
  raw: RawLogMeta;
}

export interface IntentCancelledEvent {
  eventName: "IntentCancelled";
  args: {
    intentId: Hex;
    owner: Address;
  };
  raw: RawLogMeta;
}

export interface IntentFilledEvent {
  eventName: "IntentFilled";
  args: {
    intentId: Hex;
    solver: Address;
    amountIn: bigint;
    amountOut: bigint;
  };
  raw: RawLogMeta;
}

export type DecodedIntentEvent = IntentCreatedEvent | IntentCancelledEvent | IntentFilledEvent;

export function toRawLogMeta(log: Log): RawLogMeta {
  return {
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    removed: log.removed,
    topics: log.topics,
  };
}
