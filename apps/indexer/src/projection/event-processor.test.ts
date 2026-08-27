import { beforeEach, describe, expect, it } from "vitest";
import { createChain, getIntent, listFillsByIntent } from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../pipeline/test-setup.js";
import type {
  DecodedIntentEvent,
  IntentCancelledEvent,
  IntentCreatedEvent,
  IntentFilledEvent,
  RawLogMeta,
} from "../decoder/events.js";
import { processDecodedEvent } from "./event-processor.js";
import { ProjectionError } from "./errors.js";

const INTENT_ID = "0xintent1" as const;
const OWNER = "0xowner0000000000000000000000000000000000" as const;
const TOKEN_IN = "0xtokenin00000000000000000000000000000000" as const;
const TOKEN_OUT = "0xtokenout0000000000000000000000000000000" as const;
const SOLVER = "0xsolver000000000000000000000000000000000" as const;
const CONTRACT = "0xcontract0000000000000000000000000000000" as const;
const BLOCK_HASH = "0xblockhash000000000000000000000000000000" as const;
const DEFAULT_TX_HASH = "0xtx0000000000000000000000000000000000000000000000000000000000" as const;
const DEFAULT_TOPIC = "0xtopic0000000000000000000000000000000000000000000000000000000" as const;

function rawMeta(overrides: Partial<RawLogMeta> = {}): RawLogMeta {
  return {
    address: CONTRACT,
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    transactionHash: DEFAULT_TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    topics: [DEFAULT_TOPIC],
    ...overrides,
  };
}

function created(
  argsOverrides: Partial<IntentCreatedEvent["args"]> = {},
  rawOverrides: Partial<RawLogMeta> = {},
): IntentCreatedEvent {
  return {
    eventName: "IntentCreated",
    raw: rawMeta(rawOverrides),
    args: {
      intentId: INTENT_ID,
      owner: OWNER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: 1_000n,
      minAmountOut: 900n,
      deadline: 9_999_999_999n,
      ...argsOverrides,
    },
  };
}

function cancelled(
  argsOverrides: Partial<IntentCancelledEvent["args"]> = {},
  rawOverrides: Partial<RawLogMeta> = {},
): IntentCancelledEvent {
  return {
    eventName: "IntentCancelled",
    raw: rawMeta(rawOverrides),
    args: { intentId: INTENT_ID, owner: OWNER, ...argsOverrides },
  };
}

function filled(
  argsOverrides: Partial<IntentFilledEvent["args"]> = {},
  rawOverrides: Partial<RawLogMeta> = {},
): IntentFilledEvent {
  return {
    eventName: "IntentFilled",
    raw: rawMeta(rawOverrides),
    args: { intentId: INTENT_ID, solver: SOLVER, amountIn: 1_000n, amountOut: 950n, ...argsOverrides },
  };
}

let chainId: number;

beforeEach(async () => {
  await setupTestDb();
  chainId = randomChainId();
  await createChain(db, { chainId, name: `chain-${chainId}` });
});

describe("event processor: lifecycle", () => {
  it("full lifecycle: IntentCreated -> IntentFilled", async () => {
    await processDecodedEvent(db, chainId, created());
    const result = await processDecodedEvent(
      db,
      chainId,
      filled({}, { transactionHash: "0xfilltx" as const, logIndex: 1 }),
    );

    expect(result.eventName).toBe("IntentFilled");
    const intent = await getIntent(db, chainId, INTENT_ID);
    expect(intent?.status).toBe("FILLED");
    const fills = await listFillsByIntent(db, chainId, INTENT_ID);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ solver: SOLVER, amountOut: "950" });
  });

  it("cancellation: IntentCreated -> IntentCancelled", async () => {
    await processDecodedEvent(db, chainId, created());
    const result = await processDecodedEvent(
      db,
      chainId,
      cancelled({}, { transactionHash: "0xcanceltx" as const, logIndex: 1 }),
    );

    expect(result).toMatchObject({ eventName: "IntentCancelled" });
    const intent = await getIntent(db, chainId, INTENT_ID);
    expect(intent?.status).toBe("CANCELLED");
  });
});

describe("event processor: idempotency", () => {
  it("duplicate IntentCreated is a no-op", async () => {
    const first = await processDecodedEvent(db, chainId, created());
    const second = await processDecodedEvent(db, chainId, created());

    expect(first.eventName).toBe("IntentCreated");
    if (first.eventName !== "IntentCreated" || second.eventName !== "IntentCreated") throw new Error("unreachable");
    expect(second.intent.id).toBe(first.intent.id);
  });

  it("duplicate IntentCancelled is a no-op", async () => {
    await processDecodedEvent(db, chainId, created());
    const cancelEvent = cancelled({}, { transactionHash: "0xcanceltx" as const, logIndex: 1 });

    await processDecodedEvent(db, chainId, cancelEvent);
    const second = await processDecodedEvent(db, chainId, cancelEvent);

    expect(second).toMatchObject({ eventName: "IntentCancelled", intent: { status: "CANCELLED" } });
  });

  it("duplicate IntentFilled (same tx/logIndex) is a no-op, not a second fill row", async () => {
    await processDecodedEvent(db, chainId, created());
    const fillEvent = filled({}, { transactionHash: "0xfilltx" as const, logIndex: 1 });

    await processDecodedEvent(db, chainId, fillEvent);
    await processDecodedEvent(db, chainId, fillEvent);

    const fills = await listFillsByIntent(db, chainId, INTENT_ID);
    expect(fills).toHaveLength(1);
  });

  it("re-applying an entire range (create+fill twice) leaves state unchanged", async () => {
    const createEvent = created();
    const fillEvent = filled({}, { transactionHash: "0xfilltx" as const, logIndex: 1 });

    await processDecodedEvent(db, chainId, createEvent);
    await processDecodedEvent(db, chainId, fillEvent);
    await processDecodedEvent(db, chainId, createEvent);
    await processDecodedEvent(db, chainId, fillEvent);

    const intent = await getIntent(db, chainId, INTENT_ID);
    expect(intent?.status).toBe("FILLED");
    const fills = await listFillsByIntent(db, chainId, INTENT_ID);
    expect(fills).toHaveLength(1);
  });
});

describe("event processor: out-of-order events", () => {
  it("rejects IntentCancelled seen before any IntentCreated", async () => {
    await expect(processDecodedEvent(db, chainId, cancelled())).rejects.toThrow(ProjectionError);
  });

  it("rejects IntentFilled seen before any IntentCreated", async () => {
    await expect(processDecodedEvent(db, chainId, filled())).rejects.toThrow(ProjectionError);
  });
});

describe("event processor: invalid transitions", () => {
  it("cannot cancel an already-FILLED intent", async () => {
    await processDecodedEvent(db, chainId, created());
    await processDecodedEvent(db, chainId, filled({}, { transactionHash: "0xfilltx" as const, logIndex: 1 }));

    await expect(
      processDecodedEvent(db, chainId, cancelled({}, { transactionHash: "0xcanceltx" as const, logIndex: 2 })),
    ).rejects.toThrow(ProjectionError);
  });

  it("cannot fill an already-CANCELLED intent", async () => {
    await processDecodedEvent(db, chainId, created());
    await processDecodedEvent(db, chainId, cancelled({}, { transactionHash: "0xcanceltx" as const, logIndex: 1 }));

    await expect(
      processDecodedEvent(db, chainId, filled({}, { transactionHash: "0xfilltx" as const, logIndex: 2 })),
    ).rejects.toThrow(ProjectionError);
  });

  it("cannot apply a second, different fill to an already-FILLED intent", async () => {
    await processDecodedEvent(db, chainId, created());
    await processDecodedEvent(db, chainId, filled({}, { transactionHash: "0xfilltx1" as const, logIndex: 1 }));

    await expect(
      processDecodedEvent(db, chainId, filled({}, { transactionHash: "0xfilltx2" as const, logIndex: 2 })),
    ).rejects.toThrow(ProjectionError);
  });
});

describe("event processor: validation", () => {
  it("rejects IntentCreated with a deadline outside the safe-integer range", async () => {
    const outOfRange = created({ deadline: 2n ** 200n });

    await expect(processDecodedEvent(db, chainId, outOfRange)).rejects.toThrow(ProjectionError);
    expect(await getIntent(db, chainId, INTENT_ID)).toBeUndefined();
  });
});

describe("event processor: unknown events", () => {
  it("ignores a decoded event outside the known intent lifecycle", async () => {
    const unknown = { eventName: "SomeOtherEvent", raw: rawMeta(), args: {} } as unknown as DecodedIntentEvent;

    const result = await processDecodedEvent(db, chainId, unknown);

    expect(result).toEqual({ eventName: "ignored" });
  });
});
