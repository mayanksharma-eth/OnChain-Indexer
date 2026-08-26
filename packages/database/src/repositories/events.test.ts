import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { eventExists, getEvent, insertEvent, markEventsNonCanonical } from "./events.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
});

function event(overrides: Partial<Parameters<typeof insertEvent>[1]> = {}) {
  return {
    chainId: 1,
    blockNumber: 100,
    blockHash: "0xblock100",
    transactionHash: "0xtx1",
    transactionIndex: 0,
    logIndex: 0,
    contractAddress: "0xcontract",
    eventName: "IntentCreated",
    eventSignature: "IntentCreated(bytes32,address)",
    decodedData: { intentId: "0xabc" },
    ...overrides,
  };
}

describe("events repository", () => {
  it("inserts and retrieves an event by (chain_id, tx_hash, log_index)", async () => {
    await insertEvent(db, event());

    const found = await getEvent(db, 1, "0xtx1", 0);
    expect(found?.eventName).toBe("IntentCreated");
    expect(found?.decodedData).toEqual({ intentId: "0xabc" });
  });

  it("is idempotent: re-inserting the same event returns the existing row instead of throwing", async () => {
    const first = await insertEvent(db, event());
    const second = await insertEvent(db, event({ eventName: "Other" }));

    expect(second).toEqual(first);
    expect(second.eventName).toBe("IntentCreated");
  });

  it("reports whether an event exists", async () => {
    expect(await eventExists(db, 1, "0xtx1", 0)).toBe(false);

    await insertEvent(db, event());

    expect(await eventExists(db, 1, "0xtx1", 0)).toBe(true);
  });

  it("marks events at or above a block height non-canonical during a reorg", async () => {
    await insertEvent(db, event({ blockNumber: 100, logIndex: 0 }));
    await insertEvent(db, event({ blockNumber: 101, logIndex: 1 }));

    const flipped = await markEventsNonCanonical(db, 1, 101);

    expect(flipped).toHaveLength(1);
    expect((await getEvent(db, 1, "0xtx1", 0))?.isCanonical).toBe(true);
    expect((await getEvent(db, 1, "0xtx1", 1))?.isCanonical).toBe(false);
  });
});
