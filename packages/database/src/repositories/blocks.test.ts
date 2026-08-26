import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { getBlock, getBlockByHash, getLatestBlock, insertBlock, markNonCanonical } from "./blocks.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
});

function block(overrides: Partial<Parameters<typeof insertBlock>[1]> = {}) {
  return {
    chainId: 1,
    blockNumber: 100,
    blockHash: "0xblock100",
    parentHash: "0xblock99",
    blockTimestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("blocks repository", () => {
  it("inserts and retrieves the canonical block at a height", async () => {
    await insertBlock(db, block());

    const found = await getBlock(db, 1, 100);
    expect(found?.blockHash).toBe("0xblock100");
    expect(found?.isCanonical).toBe(true);
  });

  it("is idempotent: re-inserting the same block returns the existing row instead of throwing", async () => {
    const first = await insertBlock(db, block());
    const second = await insertBlock(db, block());

    expect(second).toEqual(first);
  });

  it("rejects a second canonical block at the same height", async () => {
    await insertBlock(db, block());
    await expect(insertBlock(db, block({ blockHash: "0xblock100-b" }))).rejects.toThrow();
  });

  it("looks up a block by hash regardless of canonical status", async () => {
    await insertBlock(db, block({ isCanonical: false }));

    expect(await getBlockByHash(db, 1, "0xblock100")).toBeDefined();
    expect(await getBlock(db, 1, 100)).toBeUndefined();
  });

  it("returns the highest canonical block as the latest", async () => {
    await insertBlock(db, block({ blockNumber: 100, blockHash: "0xa" }));
    await insertBlock(db, block({ blockNumber: 102, blockHash: "0xb" }));
    await insertBlock(db, block({ blockNumber: 101, blockHash: "0xc" }));

    expect((await getLatestBlock(db, 1))?.blockNumber).toBe(102);
  });

  it("marks blocks at or above a height non-canonical during a reorg", async () => {
    await insertBlock(db, block({ blockNumber: 100, blockHash: "0xa" }));
    await insertBlock(db, block({ blockNumber: 101, blockHash: "0xb" }));

    const flipped = await markNonCanonical(db, 1, 101);

    expect(flipped.map((b) => b.blockNumber)).toEqual([101]);
    expect(await getBlock(db, 1, 100)).toBeDefined();
    expect(await getBlock(db, 1, 101)).toBeUndefined();
  });
});
