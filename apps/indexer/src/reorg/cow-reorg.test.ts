import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type AbiEvent, type Block, type Log } from "viem";
import { cowSettlementAbi } from "@onchain-indexer/abi";
import {
  createChain,
  getBlock,
  getCheckpoint,
  getCowSettlementByTxHash,
  getEvent,
  insertBlock,
  insertCowSettlement,
  insertCowTrade,
  insertEvent,
  listCowTrades,
  saveCheckpoint,
} from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { runCowIndexingPipeline } from "../pipeline/cow-pipeline.js";
import { handleReorg } from "./reorg.js";
import { rollbackCowProjectionsFromBlock } from "../projection/cow-rollback.js";
import { db, randomChainId, setupTestDb } from "../pipeline/test-setup.js";

const SOLVER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const SELL_TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const BUY_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const ORDER_UID = `0x${"11".repeat(56)}` as const;
const CONTRACT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41" as const;

beforeAll(setupTestDb);

function encodeCow(eventName: "Trade" | "Settlement", args: Record<string, unknown>) {
  const topics = encodeEventTopics({ abi: cowSettlementAbi, eventName, args }) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const item = (cowSettlementAbi as Abi).find((i): i is AbiEvent => i.type === "event" && i.name === eventName)!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name!]));
  return { topics, data };
}

function fakeBlock(number: bigint, hash: `0x${string}`, parentHash: `0x${string}`): Block {
  return { number, hash, parentHash, timestamp: 1_700_000_000n } as unknown as Block;
}

describe("bounded reorg handling for the CoW adapter", () => {
  it("orphans a reorged settlement transaction and replays the new canonical chain's events", async () => {
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });

    // Canonical chain before the reorg: A(1) -> B(2) -> C(3), with a settlement+trade in C.
    await insertBlock(db, { chainId, blockNumber: 1, blockHash: "0xA", parentHash: "0xgenesis", blockTimestamp: new Date() });
    await insertBlock(db, { chainId, blockNumber: 2, blockHash: "0xB", parentHash: "0xA", blockTimestamp: new Date() });
    await insertBlock(db, { chainId, blockNumber: 3, blockHash: "0xC", parentHash: "0xB", blockTimestamp: new Date() });
    await insertEvent(db, {
      chainId,
      blockNumber: 3,
      blockHash: "0xC",
      transactionHash: "0xtxC",
      transactionIndex: 0,
      logIndex: 1,
      contractAddress: CONTRACT,
      eventName: "Settlement",
      eventSignature: "Settlement(address)",
      decodedData: {},
    });
    await insertCowSettlement(db, {
      chainId,
      solver: SOLVER,
      blockNumber: 3,
      blockHash: "0xC",
      transactionHash: "0xtxC",
      transactionIndex: 0,
      logIndex: 1,
    });
    await insertCowTrade(db, {
      chainId,
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: "1000",
      buyAmount: "900",
      feeAmount: "10",
      orderUid: ORDER_UID,
      blockNumber: 3,
      transactionHash: "0xtxC",
      logIndex: 0,
    });
    await saveCheckpoint(db, { chainId, indexerName: "cow-events", lastProcessedBlock: 3, lastProcessedBlockHash: "0xC" });

    // The chain has since reorganized: B's child is now D(3), followed by E(4), with a new
    // settlement in D (Trade before Settlement, matching real onchain emission order).
    const tradeLog = encodeCow("Trade", {
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: 500n,
      buyAmount: 480n,
      feeAmount: 5n,
      orderUid: ORDER_UID,
    });
    const settlementLog = encodeCow("Settlement", { solver: SOLVER });
    const newTxHash = "0xtxD";
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
      getLogs: vi.fn().mockResolvedValue([
        { address: CONTRACT, data: tradeLog.data, topics: tradeLog.topics, blockHash: "0xD", blockNumber: 3n, transactionHash: newTxHash, transactionIndex: 0, logIndex: 0, removed: false },
        { address: CONTRACT, data: settlementLog.data, topics: settlementLog.topics, blockHash: "0xD", blockNumber: 3n, transactionHash: newTxHash, transactionIndex: 0, logIndex: 1, removed: false },
      ] satisfies Log[]),
    };

    // Detect the fork, find ancestor B(2), roll back C's settlement/trade, restore checkpoint to 2.
    const result = await handleReorg(db, client, chainId, "cow-events", 3, rollbackCowProjectionsFromBlock);
    expect(result).toEqual({ ancestorBlock: 2, ancestorBlockHash: "0xB", affectedFrom: 3 });

    expect(await getBlock(db, chainId, 3)).toBeUndefined();
    expect((await getEvent(db, chainId, "0xtxC", 1))?.isCanonical).toBe(false);
    expect(await getCowSettlementByTxHash(db, chainId, "0xtxC")).toBeUndefined();
    expect(await listCowTrades(db, chainId, { transactionHash: "0xtxC", limit: 10 })).toHaveLength(0);
    expect(await getCheckpoint(db, chainId, "cow-events")).toMatchObject({ lastProcessedBlock: 2, lastProcessedBlockHash: "0xB" });

    // Replay the new canonical blocks D and E through the normal CoW pipeline.
    for await (const _ of runCowIndexingPipeline(client, db, chainId, 3, 4, 1000, { indexerName: "cow-events" })) {
      // drain
    }

    expect(await getBlock(db, chainId, 3)).toMatchObject({ blockHash: "0xD", isCanonical: true });
    const newSettlement = await getCowSettlementByTxHash(db, chainId, newTxHash);
    expect(newSettlement).toMatchObject({ solver: getAddress(SOLVER), blockNumber: 3 });
    const newTrades = await listCowTrades(db, chainId, { transactionHash: newTxHash, limit: 10 });
    expect(newTrades).toHaveLength(1);
    expect(await getCheckpoint(db, chainId, "cow-events")).toMatchObject({ lastProcessedBlock: 4, lastProcessedBlockHash: "0xE" });
  });
});
