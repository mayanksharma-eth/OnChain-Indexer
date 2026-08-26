import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createChain,
  createIntent,
  createRedis,
  invalidateChainCache,
  IntentStatus,
  type NewIntent,
} from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";
import type { RedisClient } from "../lib/http.js";

/**
 * Exercises the cache wiring end-to-end through GET /solver/state (solverState TTL = 2s, see
 * lib/cache.ts). Other cached routes (intents?status=OPEN, indexer/status) share the same
 * cache-aside helper — its core behavior is covered exhaustively in
 * packages/database/src/cache.test.ts; this file just proves a real route is actually wired to it.
 */

interface SolverStateBody {
  success: true;
  data: { chainId: number; openIntents: number; filledIntents: number; cancelledIntents: number; totalFills: number };
  indexedBlock: number | null;
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = createRedis(REDIS_URL);

const OWNER = "0x1111111111111111111111111111111111111a";
const TOKEN_IN = "0x2222222222222222222222222222222222222b";
const TOKEN_OUT = "0x3333333333333333333333333333333333333c";

function openIntentFixture(chainId: number): NewIntent {
  return {
    chainId,
    intentId: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
    owner: OWNER,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountIn: "1000",
    minAmountOut: "900",
    deadline: 9_999_999_999,
    status: IntentStatus.OPEN,
    createdBlock: 1,
    createdTxHash: "0xtx",
  };
}

function openIntents(response: Awaited<ReturnType<FastifyInstance["inject"]>>): number {
  return response.json<SolverStateBody>().data.openIntents;
}

let chainId: number;

beforeAll(setupTestDb);

beforeEach(async () => {
  chainId = randomChainId();
  await createChain(db, { chainId, name: `chain-${chainId}` });
});

afterAll(async () => {
  await redis.quit();
});

describe("GET /api/v1/solver/state caching", () => {
  it("cache miss: first request queries the DB and populates the cache", async () => {
    const app = buildTestApp(chainId, { redis });

    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });

    expect(response.statusCode).toBe(200);
    expect(openIntents(response)).toBe(0);
    expect(await redis.get(`cache:v1:solver:state:${chainId}`)).not.toBeNull();
  });

  it("cache hit: a second request within the TTL serves the cached value, not a fresh DB read", async () => {
    const app = buildTestApp(chainId, { redis });

    const first = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(openIntents(first)).toBe(0);

    await createIntent(db, openIntentFixture(chainId));

    const second = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(openIntents(second)).toBe(0);
  });

  it("cache expiration: once the TTL elapses, the next request reflects fresh DB state", async () => {
    const app = buildTestApp(chainId, { redis });

    await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    await createIntent(db, openIntentFixture(chainId));

    await new Promise((resolve) => setTimeout(resolve, 2100));

    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(openIntents(response)).toBe(1);
  }, 10_000);

  it("Redis unavailable: the route still succeeds by reading straight from the DB", async () => {
    const brokenRedis = {
      get: vi.fn(() => Promise.reject(new Error("connection refused"))),
      set: vi.fn(() => Promise.reject(new Error("connection refused"))),
    } as unknown as RedisClient;
    const app = buildTestApp(chainId, { redis: brokenRedis });

    await createIntent(db, openIntentFixture(chainId));
    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });

    expect(response.statusCode).toBe(200);
    expect(openIntents(response)).toBe(1);
  });

  it("cache invalidation: deleting the key makes the next request reflect fresh state before the TTL expires", async () => {
    const app = buildTestApp(chainId, { redis });

    await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    await createIntent(db, openIntentFixture(chainId));

    await invalidateChainCache(redis, chainId);

    const response = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(openIntents(response)).toBe(1);
  });
});
