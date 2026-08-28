import type { Block as ViemBlock } from "viem";
import type { Database, NewBlock, NewEvent } from "@onchain-indexer/database";
import { insertBlock, insertEvent } from "@onchain-indexer/database";
import type { FetchedCowBlockRange } from "../fetcher/cow-fetcher.js";
import type { DecodedCowEvent } from "../decoder/cow-events.js";
import { advanceCheckpoint } from "../checkpoint/checkpoint-service.js";
import { processDecodedCowEvent } from "../projection/cow-event-processor.js";

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

function toNewEvent(chainId: number, event: DecodedCowEvent): NewEvent {
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

export interface CowPersistResult {
  blocksProcessed: number;
  eventsProcessed: number;
  settlementsIndexed: number;
  tradesIndexed: number;
  orderEventsIndexed: number;
}

function findCheckpointBlock(fetched: FetchedCowBlockRange): ViemBlock {
  const block = fetched.blocks.find((b) => Number(b.number) === fetched.range.toBlock);
  if (!block || block.hash === null) {
    throw new Error(`missing block data for checkpoint at range end ${fetched.range.toBlock}`);
  }
  return block;
}

/**
 * CoW-protocol counterpart to pipeline/persist.ts's `persistFetchedRange` — same transactional
 * contract (raw events + projection + checkpoint advance all in one transaction, idempotent
 * upserts throughout).
 *
 * One difference from the intent pipeline: `cow_trades` has an FK to `cow_settlements` on
 * (chainId, transactionHash), but a settlement transaction's `Settlement` event is always
 * emitted *after* its `Trade` events onchain (verified against real mainnet data — see
 * cow-decoder.ts's ABI comment for the source). Processing events in strict log order would try
 * to insert a Trade before its settlement row exists. So this persists in two passes: all
 * Settlement events in the range first, then everything else in original order.
 */
export async function persistFetchedCowRange(
  db: Database,
  chainId: number,
  indexerName: string,
  fetched: FetchedCowBlockRange,
): Promise<CowPersistResult> {
  return db.transaction(async (tx) => {
    let settlementsIndexed = 0;
    let tradesIndexed = 0;
    let orderEventsIndexed = 0;

    for (const block of fetched.blocks) {
      await insertBlock(tx, toNewBlock(chainId, block));
    }
    for (const event of fetched.events) {
      await insertEvent(tx, toNewEvent(chainId, event));
    }

    const settlementEvents = fetched.events.filter((e) => e.eventName === "Settlement");
    const otherEvents = fetched.events.filter((e) => e.eventName !== "Settlement");
    for (const event of [...settlementEvents, ...otherEvents]) {
      const projected = await processDecodedCowEvent(tx, chainId, event);
      if (projected.eventName === "Settlement") settlementsIndexed++;
      if (projected.eventName === "Trade") tradesIndexed++;
      if (projected.eventName === "OrderInvalidated") orderEventsIndexed++;
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
      settlementsIndexed,
      tradesIndexed,
      orderEventsIndexed,
    };
  });
}
