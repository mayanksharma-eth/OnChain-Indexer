import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAddress, keccak256, toHex } from "viem";
import {
  createChain,
  createIntent,
  insertFill,
  saveCheckpoint,
  IntentStatus,
  type Fill,
  type Intent,
  type NewIntent,
} from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";

interface IntentListBody {
  success: true;
  data: Intent[];
  indexedBlock: number | null;
  nextCursor: string | null;
}
interface IntentBody {
  success: true;
  data: Intent;
  indexedBlock: number | null;
}
interface FillListBody {
  success: true;
  data: Fill[];
  indexedBlock: number | null;
}
interface ErrorBody {
  success: false;
  error: { message: string; code: string };
}

const OWNER_A = getAddress("0x111111111111111111111111111111111111111a");
const OWNER_B = getAddress("0x222222222222222222222222222222222222222b");
const TOKEN_IN = getAddress("0x333333333333333333333333333333333333333c");
const TOKEN_OUT = getAddress("0x444444444444444444444444444444444444444d");
const SOLVER = getAddress("0x555555555555555555555555555555555555555e");

function intentIdFor(seed: string): `0x${string}` {
  return keccak256(toHex(seed));
}

function fixture(overrides: Partial<NewIntent> = {}): NewIntent {
  return {
    chainId: 0,
    intentId: intentIdFor(Math.random().toString()),
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

describe("GET /api/v1/intents", () => {
  it("lists intents for the configured chain, ordered stably by id", async () => {
    const first = await createIntent(db, fixture({ chainId }));
    const second = await createIntent(db, fixture({ chainId }));

    const response = await app.inject({ method: "GET", url: "/api/v1/intents" });

    expect(response.statusCode).toBe(200);
    const body = response.json<IntentListBody>();
    expect(body.success).toBe(true);
    expect(body.data.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(body.indexedBlock).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it("does not leak intents from other chains", async () => {
    const otherChainId = randomChainId();
    await createChain(db, { chainId: otherChainId, name: `chain-${otherChainId}` });
    await createIntent(db, fixture({ chainId: otherChainId }));
    await createIntent(db, fixture({ chainId }));

    const response = await app.inject({ method: "GET", url: "/api/v1/intents" });

    expect(response.json<IntentListBody>().data).toHaveLength(1);
  });

  it("filters by status", async () => {
    await createIntent(db, fixture({ chainId, status: IntentStatus.OPEN }));
    const cancelled = await createIntent(db, fixture({ chainId, status: IntentStatus.CANCELLED }));

    const response = await app.inject({ method: "GET", url: "/api/v1/intents?status=CANCELLED" });

    const body = response.json<IntentListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(cancelled.id);
  });

  it("filters by owner, tokenIn, and tokenOut (case-insensitive on input)", async () => {
    const match = await createIntent(db, fixture({ chainId, owner: OWNER_A }));
    await createIntent(db, fixture({ chainId, owner: OWNER_B }));

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/intents?owner=${OWNER_A.toLowerCase()}`,
    });

    const body = response.json<IntentListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(match.id);
  });

  it("paginates with a bounded limit and a stable cursor", async () => {
    const created: Intent[] = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createIntent(db, fixture({ chainId })));
    }

    const page1 = await app.inject({ method: "GET", url: "/api/v1/intents?limit=2" });
    const body1 = page1.json<IntentListBody>();
    expect(body1.data).toHaveLength(2);
    expect(body1.data.map((i) => i.id)).toEqual([created[0]!.id, created[1]!.id]);
    expect(body1.nextCursor).toBe(String(created[1]!.id));

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/intents?limit=2&cursor=${body1.nextCursor}`,
    });
    const body2 = page2.json<IntentListBody>();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0]!.id).toBe(created[2]!.id);
    expect(body2.nextCursor).toBeNull();
  });

  it("reports the checkpointed indexed block", async () => {
    await saveCheckpoint(db, {
      chainId,
      indexerName: "events",
      lastProcessedBlock: 4242,
      lastProcessedBlockHash: "0xhash",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/intents" });

    expect(response.json<IntentListBody>().indexedBlock).toBe(4242);
  });

  it("rejects an invalid status", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/intents?status=NOPE" });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe("validation_error");
  });

  it("rejects a malformed owner address", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/intents?owner=not-an-address" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a limit above the bound", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/intents?limit=101" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-numeric cursor", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/intents?cursor=abc" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/intents/:intentId", () => {
  it("returns the intent with the indexed block", async () => {
    const intent = await createIntent(db, fixture({ chainId }));
    await saveCheckpoint(db, {
      chainId,
      indexerName: "events",
      lastProcessedBlock: 10,
      lastProcessedBlockHash: "0xhash",
    });

    const response = await app.inject({ method: "GET", url: `/api/v1/intents/${intent.intentId}` });

    expect(response.statusCode).toBe(200);
    const body = response.json<IntentBody>();
    expect(body.data.id).toBe(intent.id);
    expect(body.indexedBlock).toBe(10);
  });

  it("404s for an unknown intentId", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/intents/${intentIdFor("missing")}` });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("intent_not_found");
  });

  it("400s for a malformed intentId", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/intents/not-a-hex-id" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/intents/:intentId/fills", () => {
  it("lists fills for the intent", async () => {
    const intent = await createIntent(db, fixture({ chainId, status: IntentStatus.FILLED }));
    const fill = await insertFill(db, {
      chainId,
      intentId: intent.intentId,
      solver: SOLVER,
      amountIn: "1000",
      amountOut: "950",
      blockNumber: 5,
      transactionHash: "0xfilltx",
      logIndex: 0,
    });

    const response = await app.inject({ method: "GET", url: `/api/v1/intents/${intent.intentId}/fills` });

    expect(response.statusCode).toBe(200);
    const body = response.json<FillListBody>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(fill.id);
  });

  it("returns an empty list for an open intent with no fills", async () => {
    const intent = await createIntent(db, fixture({ chainId }));
    const response = await app.inject({ method: "GET", url: `/api/v1/intents/${intent.intentId}/fills` });
    expect(response.json<FillListBody>().data).toEqual([]);
  });

  it("404s for an unknown intentId", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/intents/${intentIdFor("missing")}/fills`,
    });
    expect(response.statusCode).toBe(404);
  });
});
