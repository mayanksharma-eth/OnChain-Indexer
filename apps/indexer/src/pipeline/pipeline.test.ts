import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Abi, type AbiEvent, type Block, type Log } from "viem";
import { intentAbi } from "@onchain-indexer/abi";
import { createChain, getBlock, getCheckpoint, getEvent } from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { runIndexingPipeline } from "./pipeline.js";
import { persistFetchedRange } from "./persist.js";
import { loadStartBlock } from "../checkpoint/checkpoint-service.js";
import type { FetchedBlockRange } from "../fetcher/fetcher.js";
import { db, randomChainId, setupTestDb } from "./test-setup.js";

const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN_IN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const TOKEN_OUT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const TX_HASH = "0xtxhash00000000000000000000000000000000000000000000000000000" as const;
const BLOCK_HASH = "0xblockhash000000000000000000000000000000000000000000000000000" as const;
const PARENT_HASH = "0xparenthash0000000000000000000000000000000000000000000000000" as const;
const INTENT_ID = keccak256(toHex("intent-1"));

beforeAll(setupTestDb);

function encodeIntentCreated(): { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` } {
  const eventArgs = {
    intentId: INTENT_ID,
    owner: OWNER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
    minAmountOut: 900n,
    deadline: 9_999_999n,
  };
  const topics = encodeEventTopics({
    abi: intentAbi,
    eventName: "IntentCreated",
    args: eventArgs,
  }) as [`0x${string}`, ...`0x${string}`[]];
  const item = (intentAbi as Abi).find(
    (i): i is AbiEvent => i.type === "event" && i.name === "IntentCreated",
  )!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => eventArgs[input.name as keyof typeof eventArgs]),
  );
  return { topics, data };
}

function fakeLog(overrides: Partial<Log> = {}): Log {
  const encoded = encodeIntentCreated();
  return {
    address: CONTRACT,
    data: encoded.data,
    topics: encoded.topics,
    blockHash: BLOCK_HASH,
    blockNumber: 500n,
    transactionHash: TX_HASH,
    transactionIndex: 3,
    logIndex: 7,
    removed: false,
    ...overrides,
  };
}

function fakeBlock(overrides: Record<string, unknown> = {}): Block {
  return {
    number: 500n,
    hash: BLOCK_HASH,
    parentHash: PARENT_HASH,
    timestamp: 1_700_000_000n,
    ...overrides,
  } as unknown as Block;
}

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getChainId: vi.fn().mockResolvedValue(31337),
    getLatestBlock: vi.fn(),
    getBlock: vi.fn().mockResolvedValue(fakeBlock()),
    getBlockByHash: vi.fn(),
    getLogs: vi.fn().mockResolvedValue([fakeLog()]),
    ...overrides,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("indexing pipeline", () => {
  it("persists blocks and decoded events end-to-end, retaining every required field", async () => {
    const chainId = randomChainId();
    const client = fakeClient();

    const results = await collect(runIndexingPipeline(client, db, chainId, 500, 500, 500));

    expect(results).toEqual([
      { fromBlock: 500, toBlock: 500, blocksProcessed: 1, eventsProcessed: 1, intentsIndexed: 1, fillsIndexed: 0 },
    ]);

    const block = await getBlock(db, chainId, 500);
    expect(block).toMatchObject({
      chainId,
      blockNumber: 500,
      blockHash: BLOCK_HASH,
      parentHash: PARENT_HASH,
      isCanonical: true,
    });

    const event = await getEvent(db, chainId, TX_HASH, 7);
    expect(event).toMatchObject({
      chainId,
      blockNumber: 500,
      blockHash: BLOCK_HASH,
      transactionHash: TX_HASH,
      transactionIndex: 3,
      logIndex: 7,
      contractAddress: CONTRACT,
      eventName: "IntentCreated",
      eventSignature: encodeIntentCreated().topics[0],
      isCanonical: true,
      decodedData: {
        intentId: INTENT_ID,
        owner: getAddress(OWNER),
        tokenIn: getAddress(TOKEN_IN),
        tokenOut: getAddress(TOKEN_OUT),
        amountIn: "1000",
        minAmountOut: "900",
        deadline: "9999999",
      },
    });
  });

  it("processing the same logs twice yields exactly one event record and one block record", async () => {
    const chainId = randomChainId();
    const client = fakeClient();

    await collect(runIndexingPipeline(client, db, chainId, 500, 500, 500));
    const firstEvent = await getEvent(db, chainId, TX_HASH, 7);
    const firstBlock = await getBlock(db, chainId, 500);
    expect(firstEvent).toBeDefined();

    // Same range, same logs, reprocessed from scratch (e.g. after a restart with no checkpoint).
    const results = await collect(runIndexingPipeline(client, db, chainId, 500, 500, 500));
    const secondEvent = await getEvent(db, chainId, TX_HASH, 7);
    const secondBlock = await getBlock(db, chainId, 500);

    expect(results).toEqual([
      { fromBlock: 500, toBlock: 500, blocksProcessed: 1, eventsProcessed: 1, intentsIndexed: 1, fillsIndexed: 0 },
    ]);
    // same row identity, not a second insert
    expect(secondEvent?.id).toBe(firstEvent?.id);
    expect(secondBlock).toEqual(firstBlock);
  });

  it("rolls back the whole range if any write in the transaction fails", async () => {
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });
    const fetched: FetchedBlockRange = {
      range: { fromBlock: 1, toBlock: 2 },
      blocks: [
        fakeBlock({ number: 1n, hash: "0xaaaa" }),
        fakeBlock({ number: 1n, hash: "0xbbbb" }), // same height as above -> violates canonical uniqueness
      ],
      events: [],
    };

    await expect(persistFetchedRange(db, chainId, "events", fetched)).rejects.toThrow();
    expect(await getBlock(db, chainId, 1)).toBeUndefined();
  });
});

describe("checkpointing", () => {
  it("advances the checkpoint to the range's end block and hash after a successful range", async () => {
    const chainId = randomChainId();
    const client = fakeClient();

    await collect(runIndexingPipeline(client, db, chainId, 500, 500, 500));

    const checkpoint = await getCheckpoint(db, chainId, "events");
    expect(checkpoint).toMatchObject({ lastProcessedBlock: 500, lastProcessedBlockHash: BLOCK_HASH });
  });

  it("does not advance the checkpoint when a range fails to commit", async () => {
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });
    // Same block height twice within the range -> violates canonical uniqueness and rolls back.
    const failingRange: FetchedBlockRange = {
      range: { fromBlock: 1000, toBlock: 1499 },
      blocks: [fakeBlock({ number: 1000n, hash: "0xaaaa" }), fakeBlock({ number: 1000n, hash: "0xbbbb" })],
      events: [],
    };

    await expect(persistFetchedRange(db, chainId, "events", failingRange)).rejects.toThrow();

    expect(await getCheckpoint(db, chainId, "events")).toBeUndefined();
  });

  it("on restart, resumes indexing from the block after the last saved checkpoint", async () => {
    const chainId = randomChainId();
    const client = fakeClient();

    await collect(runIndexingPipeline(client, db, chainId, 500, 500, 500));

    const resumeFrom = await loadStartBlock(db, { chainId, indexerName: "events" }, 0);
    expect(resumeFrom).toBe(501);
  });
});
