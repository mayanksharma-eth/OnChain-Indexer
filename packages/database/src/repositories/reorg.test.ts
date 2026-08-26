import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { getBlock, insertBlock, markNonCanonical } from "./blocks.js";
import { getEvent, insertEvent, markEventsNonCanonical } from "./events.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
  await insertBlock(db, {
    chainId: 1,
    blockNumber: 100,
    blockHash: "0xblock100",
    parentHash: "0xblock99",
    blockTimestamp: new Date("2026-01-01T00:00:00Z"),
  });
  await insertEvent(db, {
    chainId: 1,
    blockNumber: 100,
    blockHash: "0xblock100",
    transactionHash: "0xtx1",
    transactionIndex: 0,
    logIndex: 0,
    contractAddress: "0xcontract",
    eventName: "IntentCreated",
    eventSignature: "IntentCreated(bytes32,address)",
    decodedData: {},
  });
});

describe("reorg atomicity across repositories", () => {
  it("marks blocks and events non-canonical together in one transaction", async () => {
    await db.transaction(async (tx) => {
      await markNonCanonical(tx, 1, 100);
      await markEventsNonCanonical(tx, 1, 100);
    });

    expect(await getBlock(db, 1, 100)).toBeUndefined();
    expect((await getEvent(db, 1, "0xtx1", 0))?.isCanonical).toBe(false);
  });

  it("rolls back both repositories if the transaction fails partway through", async () => {
    await expect(
      db.transaction(async (tx) => {
        await markNonCanonical(tx, 1, 100);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect((await getBlock(db, 1, 100))?.isCanonical).toBe(true);
  });
});
