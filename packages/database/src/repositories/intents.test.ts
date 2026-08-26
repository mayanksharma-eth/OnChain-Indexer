import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { createIntent, getIntent, listIntentsByOwner, listOpenIntents, updateIntentStatus } from "./intents.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
});

function intent(overrides: Partial<Parameters<typeof createIntent>[1]> = {}) {
  return {
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
    ...overrides,
  };
}

describe("intents repository", () => {
  it("creates an intent with a default pending status", async () => {
    await createIntent(db, intent());

    const found = await getIntent(db, 1, "0xintent1");
    expect(found?.status).toBe("pending");
    expect(found?.amountIn).toBe("1000000000000000000");
  });

  it("rejects a duplicate (chain_id, intent_id)", async () => {
    await createIntent(db, intent());
    await expect(createIntent(db, intent())).rejects.toThrow();
  });

  it("lists intents by owner", async () => {
    await createIntent(db, intent({ intentId: "0xintent1", owner: "0xowner" }));
    await createIntent(db, intent({ intentId: "0xintent2", owner: "0xother" }));

    const owned = await listIntentsByOwner(db, 1, "0xowner");
    expect(owned.map((i) => i.intentId)).toEqual(["0xintent1"]);
  });

  it("lists only open (pending) intents", async () => {
    await createIntent(db, intent({ intentId: "0xintent1" }));
    await createIntent(db, intent({ intentId: "0xintent2" }));
    await updateIntentStatus(db, 1, "0xintent1", {
      status: "filled",
      updatedBlock: 105,
      updatedTxHash: "0xtx2",
    });

    const open = await listOpenIntents(db, 1);
    expect(open.map((i) => i.intentId)).toEqual(["0xintent2"]);
  });
});
