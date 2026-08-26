import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAddress, keccak256, toHex } from "viem";
import { createChain, createIntent, IntentStatus, type Intent, type NewIntent } from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";

interface IntentListBody {
  success: true;
  data: Intent[];
  indexedBlock: number | null;
  nextCursor: string | null;
}

const OWNER_A = getAddress("0x111111111111111111111111111111111111111a");
const OWNER_B = getAddress("0x222222222222222222222222222222222222222b");
const TOKEN_IN = getAddress("0x333333333333333333333333333333333333333c");
const TOKEN_OUT = getAddress("0x444444444444444444444444444444444444444d");

function fixture(overrides: Partial<NewIntent> = {}): NewIntent {
  return {
    chainId: 0,
    intentId: keccak256(toHex(Math.random().toString())),
    owner: OWNER_A,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: "1000",
    minAmountOut: "900",
    deadline: 9_999_999_999,
    status: IntentStatus.OPEN,
    createdBlock: 1,
    createdTxHash: "0xtx",
    ...overrides,
  };
}

let chainId: number;
let app: FastifyInstance;

beforeAll(setupTestDb);

beforeEach(async () => {
  chainId = randomChainId();
  await createChain(db, { chainId, name: `chain-${chainId}` });
  app = buildTestApp(chainId);
});

describe("GET /api/v1/addresses/:address/intents", () => {
  it("returns only intents owned by that address", async () => {
    const owned = await createIntent(db, fixture({ chainId, owner: OWNER_A }));
    await createIntent(db, fixture({ chainId, owner: OWNER_B }));

    const response = await app.inject({ method: "GET", url: `/api/v1/addresses/${OWNER_A}/intents` });

    expect(response.statusCode).toBe(200);
    const body = response.json<IntentListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(owned.id);
    expect(body.indexedBlock).toBeNull();
  });

  it("accepts a lowercase address and still matches the checksummed owner", async () => {
    await createIntent(db, fixture({ chainId, owner: OWNER_A }));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/addresses/${OWNER_A.toLowerCase()}/intents`,
    });

    expect(response.json<IntentListBody>().data).toHaveLength(1);
  });

  it("combines the address with a status filter", async () => {
    await createIntent(db, fixture({ chainId, owner: OWNER_A, status: IntentStatus.OPEN }));
    const cancelled = await createIntent(
      db,
      fixture({ chainId, owner: OWNER_A, status: IntentStatus.CANCELLED }),
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/addresses/${OWNER_A}/intents?status=CANCELLED`,
    });

    const body = response.json<IntentListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(cancelled.id);
  });

  it("400s for a malformed address", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/addresses/not-an-address/intents" });
    expect(response.statusCode).toBe(400);
  });
});
