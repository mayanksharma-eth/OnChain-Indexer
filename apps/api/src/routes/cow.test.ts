import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAddress } from "viem";
import {
  createChain,
  insertCowSettlement,
  insertCowTrade,
  saveCheckpoint,
  type CowSettlement,
  type CowTrade,
} from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";

interface SettlementListBody {
  success: true;
  data: CowSettlement[];
  indexedBlock: number | null;
  nextCursor: string | null;
}
interface TradeListBody {
  success: true;
  data: CowTrade[];
  indexedBlock: number | null;
  nextCursor: string | null;
}
interface SettlementDetailBody {
  success: true;
  data: { settlement: CowSettlement; trades: CowTrade[] };
  indexedBlock: number | null;
}
interface StatsBody {
  success: true;
  data: { chainId: number; totalSettlements: number; totalTrades: number; topSolvers: { solver: string; settlementCount: number }[] };
  indexedBlock: number | null;
}
interface ErrorBody {
  success: false;
  error: { message: string; code: string };
}

const SOLVER_A = getAddress("0x111111111111111111111111111111111111111a");
const SOLVER_B = getAddress("0x222222222222222222222222222222222222222b");
const OWNER = getAddress("0x333333333333333333333333333333333333333c");
const SELL_TOKEN = getAddress("0x444444444444444444444444444444444444444d");
const BUY_TOKEN = getAddress("0x555555555555555555555555555555555555555e");
const ORDER_UID = `0x${"11".repeat(56)}` as const;

let chainId: number;
let app: FastifyInstance;

beforeAll(setupTestDb);

beforeEach(async () => {
  chainId = randomChainId();
  await createChain(db, { chainId, name: `chain-${chainId}` });
  app = buildTestApp(chainId);
});

async function seedSettlement(overrides: Partial<Parameters<typeof insertCowSettlement>[1]> = {}) {
  return insertCowSettlement(db, {
    chainId,
    solver: SOLVER_A,
    blockNumber: 100,
    blockHash: "0xblock1",
    transactionHash: "0xtx1",
    transactionIndex: 0,
    logIndex: 1,
    ...overrides,
  });
}

describe("GET /api/v1/cow/settlements", () => {
  it("lists settlements for the configured chain, ordered stably by id", async () => {
    const first = await seedSettlement({ transactionHash: "0xtx1" });
    const second = await seedSettlement({ transactionHash: "0xtx2" });

    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements" });

    expect(response.statusCode).toBe(200);
    const body = response.json<SettlementListBody>();
    expect(body.data.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it("does not leak settlements from other chains", async () => {
    const otherChainId = randomChainId();
    await createChain(db, { chainId: otherChainId, name: `chain-${otherChainId}` });
    await insertCowSettlement(db, {
      chainId: otherChainId,
      solver: SOLVER_A,
      blockNumber: 1,
      blockHash: "0xb",
      transactionHash: "0xother",
      transactionIndex: 0,
      logIndex: 0,
    });
    await seedSettlement();

    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements" });
    expect(response.json<SettlementListBody>().data).toHaveLength(1);
  });

  it("filters by solver (case-insensitive on input)", async () => {
    const match = await seedSettlement({ solver: SOLVER_A, transactionHash: "0xtx1" });
    await seedSettlement({ solver: SOLVER_B, transactionHash: "0xtx2" });

    const response = await app.inject({ method: "GET", url: `/api/v1/cow/settlements?solver=${SOLVER_A.toLowerCase()}` });

    const body = response.json<SettlementListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(match.id);
  });

  it("filters by fromBlock/toBlock", async () => {
    await seedSettlement({ transactionHash: "0xtx1", blockNumber: 100 });
    const inRange = await seedSettlement({ transactionHash: "0xtx2", blockNumber: 200 });

    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements?fromBlock=150&toBlock=250" });

    const body = response.json<SettlementListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(inRange.id);
  });

  it("paginates with a bounded limit and a stable cursor", async () => {
    const created: CowSettlement[] = [];
    for (let i = 0; i < 3; i++) {
      created.push(await seedSettlement({ transactionHash: `0xtx${i}` }));
    }

    const page1 = await app.inject({ method: "GET", url: "/api/v1/cow/settlements?limit=2" });
    const body1 = page1.json<SettlementListBody>();
    expect(body1.data.map((s) => s.id)).toEqual([created[0]!.id, created[1]!.id]);

    const page2 = await app.inject({ method: "GET", url: `/api/v1/cow/settlements?limit=2&cursor=${body1.nextCursor}` });
    expect(page2.json<SettlementListBody>().data.map((s) => s.id)).toEqual([created[2]!.id]);
  });

  it("reports the cow-events checkpointed indexed block, independent of the intent stream", async () => {
    await saveCheckpoint(db, { chainId, indexerName: "events", lastProcessedBlock: 1, lastProcessedBlockHash: "0xintent" });
    await saveCheckpoint(db, { chainId, indexerName: "cow-events", lastProcessedBlock: 4242, lastProcessedBlockHash: "0xcow" });

    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements" });

    expect(response.json<SettlementListBody>().indexedBlock).toBe(4242);
  });

  it("rejects a malformed solver address", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements?solver=not-an-address" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a limit above the bound", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements?limit=101" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/cow/settlements/:transactionHash", () => {
  it("returns the settlement with its trades", async () => {
    await seedSettlement({ transactionHash: "0xtx1" });
    const trade = await insertCowTrade(db, {
      chainId,
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: "1000",
      buyAmount: "900",
      feeAmount: "10",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: "0xtx1",
      logIndex: 0,
    });

    const txHash = `0x${"1".repeat(64)}`;
    await seedSettlement({ transactionHash: txHash });
    await insertCowTrade(db, {
      chainId,
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: "1000",
      buyAmount: "900",
      feeAmount: "10",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: txHash,
      logIndex: 0,
    });

    const response = await app.inject({ method: "GET", url: `/api/v1/cow/settlements/${txHash}` });

    expect(response.statusCode).toBe(200);
    const body = response.json<SettlementDetailBody>();
    expect(body.data.settlement.transactionHash).toBe(txHash);
    expect(body.data.trades).toHaveLength(1);
    void trade;
  });

  it("404s for an unknown transaction hash", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/cow/settlements/0x${"9".repeat(64)}` });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("settlement_not_found");
  });

  it("400s for a malformed transaction hash", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/cow/settlements/not-a-hash" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/cow/trades and /trades/:orderUid", () => {
  it("lists trades filtered by owner and by orderUid", async () => {
    await seedSettlement({ transactionHash: "0xtx1" });
    await insertCowTrade(db, {
      chainId,
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: "1000",
      buyAmount: "900",
      feeAmount: "10",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: "0xtx1",
      logIndex: 0,
    });

    const byOwner = await app.inject({ method: "GET", url: `/api/v1/cow/trades?owner=${OWNER}` });
    expect(byOwner.json<TradeListBody>().data).toHaveLength(1);

    const byOrderUid = await app.inject({ method: "GET", url: `/api/v1/cow/trades/${ORDER_UID}` });
    expect(byOrderUid.json<TradeListBody>().data).toHaveLength(1);
  });

  it("400s for a malformed orderUid", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/cow/trades/not-a-uid" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/cow/solvers/:address", () => {
  it("lists a solver's settlements", async () => {
    await seedSettlement({ solver: SOLVER_A, transactionHash: "0xtx1" });
    await seedSettlement({ solver: SOLVER_A, transactionHash: "0xtx2" });
    await seedSettlement({ solver: SOLVER_B, transactionHash: "0xtx3" });

    const response = await app.inject({ method: "GET", url: `/api/v1/cow/solvers/${SOLVER_A}` });

    expect(response.json<SettlementListBody>().data).toHaveLength(2);
  });
});

describe("GET /api/v1/cow/stats", () => {
  it("reports total settlements, total trades, and top solvers", async () => {
    await seedSettlement({ solver: SOLVER_A, transactionHash: "0xtx1" });
    await seedSettlement({ solver: SOLVER_A, transactionHash: "0xtx2" });
    await insertCowTrade(db, {
      chainId,
      owner: OWNER,
      sellToken: SELL_TOKEN,
      buyToken: BUY_TOKEN,
      sellAmount: "1000",
      buyAmount: "900",
      feeAmount: "10",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: "0xtx1",
      logIndex: 0,
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/cow/stats" });

    expect(response.statusCode).toBe(200);
    const body = response.json<StatsBody>();
    expect(body.data.totalSettlements).toBe(2);
    expect(body.data.totalTrades).toBe(1);
    expect(body.data.topSolvers[0]).toEqual({ solver: SOLVER_A, settlementCount: 2 });
  });
});
