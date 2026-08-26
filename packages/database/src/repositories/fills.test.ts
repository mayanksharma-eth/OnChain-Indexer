import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { createIntent } from "./intents.js";
import { insertFill, listFillsByIntent } from "./fills.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
  await createIntent(db, {
    chainId: 1,
    intentId: "0xintent1",
    owner: "0xowner",
    tokenIn: "0xtokenA",
    tokenOut: "0xtokenB",
    amountIn: "1000000000000000000",
    minAmountOut: "900000000000000000",
    deadline: 9999999999,
    createdBlock: 100,
    createdTxHash: "0xtx1",
  });
});

function fill(overrides: Partial<Parameters<typeof insertFill>[1]> = {}) {
  return {
    chainId: 1,
    intentId: "0xintent1",
    solver: "0xsolver",
    amountIn: "1000000000000000000",
    amountOut: "950000000000000000",
    blockNumber: 105,
    transactionHash: "0xtx2",
    logIndex: 0,
    ...overrides,
  };
}

describe("fills repository", () => {
  it("inserts and lists a fill by intent", async () => {
    await insertFill(db, fill());

    const found = await listFillsByIntent(db, 1, "0xintent1");
    expect(found).toHaveLength(1);
    expect(found[0]?.solver).toBe("0xsolver");
  });

  it("is idempotent: re-inserting the same fill returns the existing row instead of throwing", async () => {
    const first = await insertFill(db, fill());
    const second = await insertFill(db, fill({ solver: "0xother" }));

    expect(second).toEqual(first);
    expect(second.solver).toBe("0xsolver");
  });

  it("rejects a fill referencing an unknown intent", async () => {
    await expect(insertFill(db, fill({ intentId: "0xmissing" }))).rejects.toThrow();
  });
});
