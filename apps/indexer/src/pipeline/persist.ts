import type { Block as ViemBlock } from "viem";
import type { Database, NewBlock, NewEvent } from "@onchain-indexer/database";
import { insertBlock, insertEvent } from "@onchain-indexer/database";
import type { FetchedBlockRange } from "../fetcher/fetcher.js";
import type { DecodedIntentEvent } from "../decoder/events.js";

function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

function toNewBlock(chainId: number, block: ViemBlock): NewBlock {
  if (block.number === null || block.hash === null) {
    throw new Error(`fetched block is missing number/hash (pending block?): ${String(block.hash)}`);
  }
  return {
    chainId,
    blockNumber: Number(block.number),
    blockHash: block.hash,
    parentHash: block.parentHash,
    blockTimestamp: new Date(Number(block.timestamp) * 1000),
  };
}

function toNewEvent(chainId: number, event: DecodedIntentEvent): NewEvent {
  const { raw } = event;
  const eventSignature = raw.topics[0];
  if (
    raw.blockNumber === null ||
    raw.blockHash === null ||
    raw.transactionHash === null ||
    raw.transactionIndex === null ||
    raw.logIndex === null ||
    eventSignature === undefined
  ) {
    throw new Error(`decoded ${event.eventName} log is missing required metadata (pending/removed log?)`);
  }
  return {
    chainId,
    blockNumber: Number(raw.blockNumber),
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
    contractAddress: raw.address,
    eventName: event.eventName,
    eventSignature,
    decodedData: toJsonSafe(event.args),
  };
}

export interface PersistResult {
  blocksProcessed: number;
  eventsProcessed: number;
}

/**
 * Persists one fetched+decoded range inside a single transaction. Both blocks and events are
 * inserted through their repositories' onConflictDoNothing upserts, so re-persisting a range
 * whose logs were already processed is a safe no-op rather than a duplicate insert or an error.
 */
export async function persistFetchedRange(
  db: Database,
  chainId: number,
  fetched: FetchedBlockRange,
): Promise<PersistResult> {
  return db.transaction(async (tx) => {
    for (const block of fetched.blocks) {
      await insertBlock(tx, toNewBlock(chainId, block));
    }
    for (const event of fetched.events) {
      await insertEvent(tx, toNewEvent(chainId, event));
    }
    return { blocksProcessed: fetched.blocks.length, eventsProcessed: fetched.events.length };
  });
}
