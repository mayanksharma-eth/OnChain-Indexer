import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Abi, type AbiEvent, type Block, type Log } from "viem";
import { intentAbi } from "@onchain-indexer/abi";
import {
  createChain,
  createIntent,
  getBlock,
  getCheckpoint,
  getEvent,
  getIntent,
  insertBlock,
  insertEvent,
  saveCheckpoint,
  IntentStatus,
} from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { runIndexingPipeline } from "../pipeline/index.js";
import { handleReorg, MAX_REORG_DEPTH, ReorgTooDeepError } from "./reorg.js";
import { db, randomChainId, setupTestDb } from "../pipeline/test-setup.js";

const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN_IN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const TOKEN_OUT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

beforeAll(setupTestDb);

function encodeIntentCreated(intentId: `0x${string}`): { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` } {
  const eventArgs = {
    intentId,
    owner: OWNER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: 1_000n,
    minAmountOut: 900n,
    deadline: 9_999_999n,
  };
  const topics = encodeEventTopics({ abi: intentAbi, eventName: "IntentCreated", args: eventArgs }) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const item = (intentAbi as Abi).find((i): i is AbiEvent => i.type === "event" && i.name === "IntentCreated")!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => eventArgs[input.name as keyof typeof eventArgs]),
  );
  return { topics, data };
}

function fakeLog(blockNumber: bigint, blockHash: `0x${string}`, intentId: `0x${string}`, txHash: `0x${string}`): Log {
  const encoded = encodeIntentCreated(intentId);
  return {
    address: CONTRACT,
    data: encoded.data,
    topics: encoded.topics,
    blockHash,
    blockNumber,
    transactionHash: txHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function fakeBlock(number: bigint, hash: `0x${string}`, parentHash: `0x${string}`): Block {
  return { number, hash, parentHash, timestamp: 1_700_000_000n } as unknown as Block;
}

describe("bounded reorg handling", () => {
  it("A->B->C canonical, reorg to A->B->D->E: C is orphaned, D/E become canonical, domain state and checkpoint follow", async () => {
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });

    // Canonical chain before the reorg: A(1) -> B(2) -> C(3), with an intent created in C.
    await insertBlock(db, { chainId, blockNumber: 1, blockHash: "0xA", parentHash: "0xgenesis", blockTimestamp: new Date() });
    await insertBlock(db, { chainId, blockNumber: 2, blockHash: "0xB", parentHash: "0xA", blockTimestamp: new Date() });
    await insertBlock(db, { chainId, blockNumber: 3, blockHash: "0xC", parentHash: "0xB", blockTimestamp: new Date() });
    await insertEvent(db, {
      chainId,
      blockNumber: 3,
      blockHash: "0xC",
      transactionHash: "0xtxC",
      transactionIndex: 0,
      logIndex: 0,
      contractAddress: CONTRACT,
      eventName: "IntentCreated",
      eventSignature: "IntentCreated(bytes32,address,address,address,uint256,uint256,uint256)",
      decodedData: {},
    });
    await createIntent(db, {
      chainId,
      intentId: "intent-old",
      owner: OWNER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: "1000",
      minAmountOut: "900",
      deadline: 9_999_999,
      status: IntentStatus.OPEN,
      createdBlock: 3,
      createdTxHash: "0xtxC",
    });
    await saveCheckpoint(db, { chainId, indexerName: "events", lastProcessedBlock: 3, lastProcessedBlockHash: "0xC" });

    // The chain has since reorganized: B's child is now D(3), followed by E(4).
    const newIntentId = keccak256(toHex("intent-new"));
    const client: RpcClient = {
      getChainId: vi.fn().mockResolvedValue(31337),
      getLatestBlock: vi.fn(),
      getBlock: vi.fn((n: number | bigint) => {
        switch (Number(n)) {
          case 1:
            return Promise.resolve(fakeBlock(1n, "0xA", "0xgenesis"));
          case 2:
            return Promise.resolve(fakeBlock(2n, "0xB", "0xA"));
          case 3:
            return Promise.resolve(fakeBlock(3n, "0xD", "0xB"));
          case 4:
            return Promise.resolve(fakeBlock(4n, "0xE", "0xD"));
          default:
            throw new Error(`unexpected getBlock(${n})`);
        }
      }),
      getBlockByHash: vi.fn(),
      getLogs: vi.fn().mockResolvedValue([fakeLog(3n, "0xD", newIntentId, "0xtxD")]),
    };

    // 1-4: detect the fork (checkpoint's block 3 no longer matches the chain), find ancestor
    // B(2), mark C and its event non-canonical, roll back the intent it created, restore the
    // checkpoint to the ancestor.
    const result = await handleReorg(db, client, chainId, "events", 3);
    expect(result).toEqual({ ancestorBlock: 2, ancestorBlockHash: "0xB", affectedFrom: 3 });

    expect(await getBlock(db, chainId, 3)).toBeUndefined();
    expect((await getEvent(db, chainId, "0xtxC", 0))?.isCanonical).toBe(false);
    expect(await getIntent(db, chainId, "intent-old")).toBeUndefined();
    expect(await getCheckpoint(db, chainId, "events")).toMatchObject({
      lastProcessedBlock: 2,
      lastProcessedBlockHash: "0xB",
    });

    // 5-6: re-fetch and replay the new canonical blocks D and E through the normal pipeline,
    // starting right after the restored checkpoint.
    for await (const _ of runIndexingPipeline(client, db, chainId, 3, 4, 1000, { indexerName: "events" })) {
      // drain
    }

    expect(await getBlock(db, chainId, 3)).toMatchObject({ blockHash: "0xD", isCanonical: true });
    expect(await getBlock(db, chainId, 4)).toMatchObject({ blockHash: "0xE", isCanonical: true });
    expect(await getIntent(db, chainId, newIntentId)).toMatchObject({
      status: IntentStatus.OPEN,
      createdBlock: 3,
      owner: getAddress(OWNER),
    });
    expect(await getCheckpoint(db, chainId, "events")).toMatchObject({
      lastProcessedBlock: 4,
      lastProcessedBlockHash: "0xE",
    });
  });

  it("stops with ReorgTooDeepError when no common ancestor is found within MAX_REORG_DEPTH", async () => {
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });

    const divergentBlockNumber = 25;
    for (let n = divergentBlockNumber - MAX_REORG_DEPTH; n < divergentBlockNumber; n++) {
      await insertBlock(db, {
        chainId,
        blockNumber: n,
        blockHash: `0xlocal${n}`,
        parentHash: `0xlocal${n - 1}`,
        blockTimestamp: new Date(),
      });
    }

    const client: RpcClient = {
      getChainId: vi.fn().mockResolvedValue(31337),
      getLatestBlock: vi.fn(),
      // Every height the chain reports now disagrees with what's stored locally.
      getBlock: vi.fn((n: number | bigint) => Promise.resolve(fakeBlock(BigInt(n), `0xremote${Number(n)}`, `0xremote${Number(n) - 1}`))),
      getBlockByHash: vi.fn(),
      getLogs: vi.fn().mockResolvedValue([]),
    };

    await expect(handleReorg(db, client, chainId, "events", divergentBlockNumber)).rejects.toThrow(ReorgTooDeepError);
  });
});
