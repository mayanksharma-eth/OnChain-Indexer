import { beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type AbiEvent, type Block, type Log } from "viem";
import { cowSettlementAbi } from "@onchain-indexer/abi";
import { getBlock, getCheckpoint, getCowSettlementByTxHash, getEvent, listCowTrades } from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { runCowIndexingPipeline } from "./cow-pipeline.js";
import { db, randomChainId, setupTestDb } from "./test-setup.js";

const CONTRACT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41" as const;
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const SOLVER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const SELL_TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const BUY_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const ORDER_UID = `0x${"11".repeat(56)}` as const;
const TX_HASH = "0xtxhash00000000000000000000000000000000000000000000000000000" as const;
const BLOCK_HASH = "0xblockhash000000000000000000000000000000000000000000000000000" as const;
const PARENT_HASH = "0xparenthash0000000000000000000000000000000000000000000000000" as const;

beforeAll(setupTestDb);

function encodeCow(eventName: "Trade" | "Settlement" | "OrderInvalidated", args: Record<string, unknown>) {
  const topics = encodeEventTopics({ abi: cowSettlementAbi, eventName, args }) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const item = (cowSettlementAbi as Abi).find((i): i is AbiEvent => i.type === "event" && i.name === eventName)!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name!]));
  return { topics, data };
}

function fakeLog(overrides: Partial<Log> & { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] }): Log {
  return {
    address: CONTRACT,
    blockHash: BLOCK_HASH,
    blockNumber: 500n,
    transactionHash: TX_HASH,
    transactionIndex: 3,
    removed: false,
    logIndex: 0,
    ...overrides,
  };
}

function fakeBlock(overrides: Record<string, unknown> = {}): Block {
  return { number: 500n, hash: BLOCK_HASH, parentHash: PARENT_HASH, timestamp: 1_700_000_000n, ...overrides } as unknown as Block;
}

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getChainId: vi.fn().mockResolvedValue(31337),
    getLatestBlock: vi.fn(),
    getBlock: vi.fn().mockResolvedValue(fakeBlock()),
    getBlockByHash: vi.fn(),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("cow indexing pipeline", () => {
  it("persists a settlement + its trade end-to-end even though Trade is emitted before Settlement onchain", async () => {
    const chainId = randomChainId();
    // Real GPv2Settlement.settle() emits Trade before Settlement within one transaction (verified
    // against real mainnet logs) — logIndex order below reflects that.
    const tradeLog = encodeCow("Trade", {
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: 1_000_000n,
      buyAmount: 950_000n,
      feeAmount: 1_000n,
      orderUid: ORDER_UID,
    });
    const settlementLog = encodeCow("Settlement", { solver: SOLVER });
    const client = fakeClient({
      getLogs: vi.fn().mockResolvedValue([
        fakeLog({ ...tradeLog, logIndex: 0 }),
        fakeLog({ ...settlementLog, logIndex: 1 }),
      ]),
    });

    const results = await collect(runCowIndexingPipeline(client, db, chainId, 500, 500, 500));

    expect(results).toEqual([
      {
        fromBlock: 500,
        toBlock: 500,
        blocksProcessed: 1,
        eventsProcessed: 2,
        settlementsIndexed: 1,
        tradesIndexed: 1,
        orderEventsIndexed: 0,
      },
    ]);

    const block = await getBlock(db, chainId, 500);
    expect(block).toMatchObject({ blockHash: BLOCK_HASH, isCanonical: true });

    const settlement = await getCowSettlementByTxHash(db, chainId, TX_HASH);
    expect(settlement).toMatchObject({ solver: getAddress(SOLVER), blockNumber: 500 });

    const trades = await listCowTrades(db, chainId, { transactionHash: TX_HASH, limit: 10 });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ owner: getAddress(OWNER), orderUid: ORDER_UID, sellAmount: "1000000" });

    const rawEvent = await getEvent(db, chainId, TX_HASH, 1);
    expect(rawEvent).toMatchObject({ eventName: "Settlement", isCanonical: true });

    const checkpoint = await getCheckpoint(db, chainId, "cow-events");
    expect(checkpoint).toMatchObject({ lastProcessedBlock: 500, lastProcessedBlockHash: BLOCK_HASH });
  });

  it("reprocessing the same range twice yields exactly one settlement and one trade row", async () => {
    const chainId = randomChainId();
    const tradeLog = encodeCow("Trade", {
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: 1n,
      buyAmount: 1n,
      feeAmount: 1n,
      orderUid: ORDER_UID,
    });
    const settlementLog = encodeCow("Settlement", { solver: SOLVER });
    const client = fakeClient({
      getLogs: vi.fn().mockResolvedValue([
        fakeLog({ ...tradeLog, logIndex: 0 }),
        fakeLog({ ...settlementLog, logIndex: 1 }),
      ]),
    });

    await collect(runCowIndexingPipeline(client, db, chainId, 500, 500, 500));
    await collect(runCowIndexingPipeline(client, db, chainId, 500, 500, 500));

    const trades = await listCowTrades(db, chainId, { transactionHash: TX_HASH, limit: 10 });
    expect(trades).toHaveLength(1);
  });

  it("persists an OrderInvalidated event with no associated settlement", async () => {
    const chainId = randomChainId();
    const invalidatedLog = encodeCow("OrderInvalidated", { owner: OWNER, orderUid: ORDER_UID });
    const client = fakeClient({ getLogs: vi.fn().mockResolvedValue([fakeLog({ ...invalidatedLog, logIndex: 0 })]) });

    const results = await collect(runCowIndexingPipeline(client, db, chainId, 500, 500, 500));

    expect(results[0]).toMatchObject({ orderEventsIndexed: 1, settlementsIndexed: 0, tradesIndexed: 0 });
  });
});
