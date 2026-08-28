import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import {
  countCowSettlements,
  countCowTrades,
  deleteCowSettlementsFromBlock,
  deleteCowTradesFromBlock,
  getCowSettlementByTxHash,
  insertCowOrderEvent,
  insertCowSettlement,
  insertCowTrade,
  listCowOrderEventsByOrderUid,
  listCowSettlements,
  listCowTrades,
  topCowSolvers,
} from "./cow.js";

const ORDER_UID = `0x${"11".repeat(56)}` as const;

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
});

function settlement(overrides: Partial<Parameters<typeof insertCowSettlement>[1]> = {}) {
  return {
    chainId: 1,
    solver: "0xsolver1",
    blockNumber: 100,
    blockHash: "0xblock1",
    transactionHash: "0xtx1",
    transactionIndex: 0,
    logIndex: 5,
    ...overrides,
  };
}

function trade(overrides: Partial<Parameters<typeof insertCowTrade>[1]> = {}) {
  return {
    chainId: 1,
    owner: "0xowner1",
    sellToken: "0xtokenA",
    buyToken: "0xtokenB",
    sellAmount: "1000000000000000000",
    buyAmount: "950000000000000000",
    feeAmount: "1000000000000000",
    orderUid: ORDER_UID,
    blockNumber: 100,
    transactionHash: "0xtx1",
    logIndex: 0,
    ...overrides,
  };
}

describe("cow settlements repository", () => {
  it("inserts and reads back a settlement by transaction hash", async () => {
    await insertCowSettlement(db, settlement());

    const found = await getCowSettlementByTxHash(db, 1, "0xtx1");
    expect(found).toMatchObject({ solver: "0xsolver1", blockNumber: 100 });
  });

  it("is idempotent: re-inserting the same (chainId, txHash) returns the existing row", async () => {
    const first = await insertCowSettlement(db, settlement());
    const second = await insertCowSettlement(db, settlement({ solver: "0xdifferent" }));

    expect(second).toEqual(first);
    expect(second.solver).toBe("0xsolver1");
  });

  it("lists settlements filtered by solver and paginates by cursor", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx1", solver: "0xsolverA" }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2", solver: "0xsolverB" }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx3", solver: "0xsolverA" }));

    const bySolver = await listCowSettlements(db, 1, { solver: "0xsolverA", limit: 10 });
    expect(bySolver).toHaveLength(2);

    const firstPage = await listCowSettlements(db, 1, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    const secondPage = await listCowSettlements(db, 1, { limit: 2, cursor: firstPage[1]!.id });
    expect(secondPage).toHaveLength(1);
  });

  it("filters settlements by block range", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx1", blockNumber: 100 }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2", blockNumber: 200 }));

    const inRange = await listCowSettlements(db, 1, { fromBlock: 150, toBlock: 250, limit: 10 });
    expect(inRange).toHaveLength(1);
    expect(inRange[0]?.transactionHash).toBe("0xtx2");
  });

  it("counts settlements and ranks top solvers by settlement count", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx1", solver: "0xsolverA" }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2", solver: "0xsolverA" }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx3", solver: "0xsolverB" }));

    expect(await countCowSettlements(db, 1)).toBe(3);
    const top = await topCowSolvers(db, 1, 10);
    expect(top[0]).toEqual({ solver: "0xsolverA", settlementCount: 2 });
    expect(top[1]).toEqual({ solver: "0xsolverB", settlementCount: 1 });
  });

  it("reorg support: deletes settlements at or above a block number", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx1", blockNumber: 100 }));
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2", blockNumber: 200 }));

    const deleted = await deleteCowSettlementsFromBlock(db, 1, 150);
    expect(deleted).toHaveLength(1);
    expect(await countCowSettlements(db, 1)).toBe(1);
  });
});

describe("cow trades repository", () => {
  beforeEach(async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx1" }));
  });

  it("inserts and lists trades, and rejects a trade referencing an unknown settlement", async () => {
    await insertCowTrade(db, trade());
    const rows = await listCowTrades(db, 1, { transactionHash: "0xtx1", limit: 10 });
    expect(rows).toHaveLength(1);

    await expect(insertCowTrade(db, trade({ transactionHash: "0xmissing", logIndex: 1 }))).rejects.toThrow();
  });

  it("is idempotent: re-inserting the same (chainId, txHash, logIndex) returns the existing row", async () => {
    const first = await insertCowTrade(db, trade());
    const second = await insertCowTrade(db, trade({ owner: "0xdifferent" }));

    expect(second).toEqual(first);
    expect(second.owner).toBe("0xowner1");
  });

  it("lists an order's full execution history across multiple trades by orderUid", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2" }));
    await insertCowTrade(db, trade({ transactionHash: "0xtx1", logIndex: 0, orderUid: ORDER_UID }));
    await insertCowTrade(db, trade({ transactionHash: "0xtx2", logIndex: 0, orderUid: ORDER_UID }));

    const history = await listCowTrades(db, 1, { orderUid: ORDER_UID, limit: 10 });
    expect(history).toHaveLength(2);
  });

  it("filters trades by owner", async () => {
    await insertCowTrade(db, trade({ owner: "0xowner1", logIndex: 0 }));
    await insertCowTrade(db, trade({ owner: "0xowner2", logIndex: 1 }));

    const rows = await listCowTrades(db, 1, { owner: "0xowner2", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner).toBe("0xowner2");
  });

  it("counts trades and supports reorg rollback by block number", async () => {
    await insertCowSettlement(db, settlement({ transactionHash: "0xtx2", blockNumber: 200 }));
    await insertCowTrade(db, trade({ transactionHash: "0xtx1", blockNumber: 100, logIndex: 0 }));
    await insertCowTrade(db, trade({ transactionHash: "0xtx2", blockNumber: 200, logIndex: 0 }));

    expect(await countCowTrades(db, 1)).toBe(2);
    const deleted = await deleteCowTradesFromBlock(db, 1, 150);
    expect(deleted).toHaveLength(1);
    expect(await countCowTrades(db, 1)).toBe(1);
  });
});

describe("cow order events repository", () => {
  it("inserts and lists order-invalidation history by orderUid, idempotently", async () => {
    const first = await insertCowOrderEvent(db, {
      chainId: 1,
      owner: "0xowner1",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: "0xtx1",
      logIndex: 0,
    });
    const second = await insertCowOrderEvent(db, {
      chainId: 1,
      owner: "0xdifferent",
      orderUid: ORDER_UID,
      blockNumber: 100,
      transactionHash: "0xtx1",
      logIndex: 0,
    });

    expect(second).toEqual(first);

    const history = await listCowOrderEventsByOrderUid(db, 1, ORDER_UID);
    expect(history).toHaveLength(1);
    expect(history[0]?.owner).toBe("0xowner1");
  });
});
