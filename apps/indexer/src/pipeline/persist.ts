import type { Block as ViemBlock } from "viem";
import type { Database, NewBlock, NewEvent } from "@onchain-indexer/database";
import { insertBlock, insertEvent } from "@onchain-indexer/database";
import type { FetchedBlockRange } from "../fetcher/fetcher.js";
import type { DecodedIntentEvent } from "../decoder/events.js";
import { advanceCheckpoint } from "../checkpoint/checkpoint-service.js";
import { processDecodedEvent } from "../projection/event-processor.js";

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
  intentsIndexed: number;
  fillsIndexed: number;
}

function findCheckpointBlock(fetched: FetchedBlockRange): ViemBlock {
  const block = fetched.blocks.find((b) => Number(b.number) === fetched.range.toBlock);
  if (!block || block.hash === null) {
    throw new Error(`missing block data for checkpoint at range end ${fetched.range.toBlock}`);
  }
  return block;
}

/**
 * Persists one fetched+decoded range inside a single transaction. Both blocks and events are
 * inserted through their repositories' onConflictDoNothing upserts, so re-persisting a range
 * whose logs were already processed is a safe no-op rather than a duplicate insert or an error.
 *
 * Each event is also projected into domain state (intents/fills) in the same transaction, right
 * after its immutable raw row is written — see apps/indexer/src/projection. The raw events table
 * never changes after insert; the projection is what derives current queryable intent/fill state
 * from it.
 *
 * The checkpoint is advanced in this same transaction, to the range's end block/hash. That's
 * what makes the checkpoint only ever advance after a successful commit — if any write in the
 * range fails, the whole transaction (checkpoint and domain state included) rolls back untouched.
 */
export async function persistFetchedRange(
  db: Database,
  chainId: number,
  indexerName: string,
  fetched: FetchedBlockRange,
): Promise<PersistResult> {
  return db.transaction(async (tx) => {
    let intentsIndexed = 0;
    let fillsIndexed = 0;
    for (const block of fetched.blocks) {
      await insertBlock(tx, toNewBlock(chainId, block));
    }
    for (const event of fetched.events) {
      await insertEvent(tx, toNewEvent(chainId, event));
      const projected = await processDecodedEvent(tx, chainId, event);
      if (projected.eventName === "IntentCreated") intentsIndexed++;
      if (projected.eventName === "IntentFilled") fillsIndexed++;
    }
    const checkpointBlock = findCheckpointBlock(fetched);
    await advanceCheckpoint(
      tx,
      { chainId, indexerName },
      { blockNumber: fetched.range.toBlock, blockHash: checkpointBlock.hash as string },
    );
    return {
      blocksProcessed: fetched.blocks.length,
      eventsProcessed: fetched.events.length,
      intentsIndexed,
      fillsIndexed,
    };
  });
}
