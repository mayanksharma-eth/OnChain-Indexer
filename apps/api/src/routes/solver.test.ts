import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAddress, keccak256, toHex } from "viem";
import { createChain, createIntent, insertFill, saveCheckpoint, IntentStatus, type NewIntent } from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";

interface SolverStateBody {
  success: true;
  data: {
    chainId: number;
    openIntents: number;
    filledIntents: number;
    cancelledIntents: number;
    totalFills: number;
  };
  indexedBlock: number | null;
}

const OWNER = getAddress("0x111111111111111111111111111111111111111a");
const TOKEN_IN = getAddress("0x333333333333333333333333333333333333333c");
const TOKEN_OUT = getAddress("0x444444444444444444444444444444444444444d");
const SOLVER = getAddress("0x555555555555555555555555555555555555555e");

function fixture(overrides: Partial<NewIntent> = {}): NewIntent {
  return {
    chainId: 0,
    intentId: keccak256(toHex(Math.random().toString())),
    owner: OWNER,
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

describe("GET /api/v1/solver/state", () => {
  it("returns zeroed counts with a null indexed block for a fresh chain", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });

    expect(response.statusCode).toBe(200);
    const body = response.json<SolverStateBody>();
    expect(body.data).toEqual({
      chainId,
      openIntents: 0,
      filledIntents: 0,
      cancelledIntents: 0,
      totalFills: 0,
    });
    expect(body.indexedBlock).toBeNull();
  });

  it("aggregates intent counts by status and total fills, at the indexed block", async () => {
    await createIntent(db, fixture({ chainId, status: IntentStatus.OPEN }));
    await createIntent(db, fixture({ chainId, status: IntentStatus.OPEN }));
    await createIntent(db, fixture({ chainId, status: IntentStatus.CANCELLED }));
    const filled = await createIntent(db, fixture({ chainId, status: IntentStatus.FILLED }));
    await insertFill(db, {
      chainId,
      intentId: filled.intentId,
      solver: SOLVER,
      amountIn: "1000",
      amountOut: "950",
      blockNumber: 5,
      transactionHash: "0xfilltx",
      logIndex: 0,
    });
    await saveCheckpoint(db, {
      chainId,
      indexerName: "events",
      lastProcessedBlock: 99,
      lastProcessedBlockHash: "0xhash",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });

    const body = response.json<SolverStateBody>();
    expect(body.data).toEqual({
      chainId,
      openIntents: 2,
      filledIntents: 1,
      cancelledIntents: 1,
      totalFills: 1,
    });
    expect(body.indexedBlock).toBe(99);
  });

  it("does not mix counts across chains", async () => {
    const otherChainId = randomChainId();
    await createChain(db, { chainId: otherChainId, name: `chain-${otherChainId}` });
    await createIntent(db, fixture({ chainId: otherChainId }));

    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });

    expect(response.json<SolverStateBody>().data.openIntents).toBe(0);
  });
});
