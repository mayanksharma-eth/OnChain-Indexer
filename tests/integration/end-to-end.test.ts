import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  toHex,
  type Abi,
  type AbiEvent,
  type Block,
  type Hash,
  type Log,
} from "viem";
import { intentAbi } from "@onchain-indexer/abi";
import {
  countFills,
  countIntentsByStatus,
  getBlockByHash,
  getEvent,
  getIntent,
  IntentStatus,
} from "@onchain-indexer/database";
import type { RpcClient } from "../../apps/indexer/src/rpc/index.js";
import type { AppState } from "../../apps/api/src/lib/http.js";
import { runIndexerLoop } from "../../apps/indexer/src/loop/index.js";
import { runIndexingPipeline } from "../../apps/indexer/src/pipeline/index.js";
import { buildApp } from "../../apps/api/src/app.js";
import type { RedisClient } from "../../apps/api/src/lib/http.js";
import { db, randomChainId, setupTestDb } from "./test-setup.js";

/**
 * Full-stack scenario: a deterministic in-memory chain drives the real indexer loop (pipeline,
 * checkpointing, reorg detection) against real Postgres, and the real Fastify app reads the
 * results back over HTTP — with Redis deliberately broken throughout, to prove every route
 * degrades to the database rather than failing. Each unit involved (decoder, projection,
 * checkpoint idempotency, reorg bounds, RPC retry, cache fallback) already has focused tests
 * next to its source; this file's only job is proving they're wired together correctly end to
 * end, including across a simulated indexer restart and chain reorg.
 */

const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const TOKEN_IN = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const TOKEN_OUT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const SOLVER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

const INTENT_ID = keccak256(toHex("e2e-intent-created-then-filled"));
const INTENT_ID_CANCELLED = keccak256(toHex("e2e-intent-created-then-cancelled"));
const INTENT_ID_POST_REORG = keccak256(toHex("e2e-intent-only-on-new-canonical-chain"));

type EventName = "IntentCreated" | "IntentCancelled" | "IntentFilled";

function encodeEvent(eventName: EventName, args: Record<string, unknown>): { topics: [Hash, ...Hash[]]; data: Hash } {
  const topics = encodeEventTopics({ abi: intentAbi, eventName, args } as never) as [Hash, ...Hash[]];
  const item = (intentAbi as Abi).find((i): i is AbiEvent => i.type === "event" && i.name === eventName)!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => args[input.name as string]),
  );
  return { topics, data };
}

function makeLog(params: {
  blockNumber: number;
  blockHash: Hash;
  txHash: Hash;
  logIndex: number;
  eventName: EventName;
  args: Record<string, unknown>;
}): Log {
  const encoded = encodeEvent(params.eventName, params.args);
  return {
    address: CONTRACT,
    data: encoded.data,
    topics: encoded.topics,
    blockHash: params.blockHash,
    blockNumber: BigInt(params.blockNumber),
    transactionHash: params.txHash,
    transactionIndex: params.logIndex,
    logIndex: params.logIndex,
    removed: false,
  };
}

interface MockChainBlock {
  hash: Hash;
  parentHash: Hash;
  logs: Log[];
}

/** A minimal deterministic "chain": a map of block number -> (hash, parentHash, logs), mutable
 * so a test can simulate a reorg by overwriting a block number with a different hash/logs. */
function makeMockChain() {
  const byNumber = new Map<number, MockChainBlock>();

  function setBlock(number: number, data: MockChainBlock): void {
    byNumber.set(number, data);
  }

  function asBlock(number: number): Block {
    const data = byNumber.get(number);
    if (!data) throw new Error(`mock chain has no block ${number}`);
    return { number: BigInt(number), hash: data.hash, parentHash: data.parentHash, timestamp: 1_700_000_000n } as unknown as Block;
  }

  function blockByHash(hash: Hash): Block {
    for (const [number, data] of byNumber) {
      if (data.hash === hash) return asBlock(number);
    }
    throw new Error(`mock chain has no block with hash ${hash}`);
  }

  function logsInRange(fromBlock: number, toBlock: number): Log[] {
    const out: Log[] = [];
    for (let n = fromBlock; n <= toBlock; n++) out.push(...(byNumber.get(n)?.logs ?? []));
    return out;
  }

  return { setBlock, asBlock, blockByHash, logsInRange };
}

/** Wraps a MockChain as an RpcClient (same shape used by pipeline/loop/reorg tests next to the
 * indexer source), plus a lever to make the next getLogs call fail once — for the RPC
 * failure/retry scenario — without disturbing every other call. */
function makeRpcClient(chain: ReturnType<typeof makeMockChain>, latest: { current: number }) {
  let failNextGetLogs = false;
  const getLogs = vi.fn((fromBlock: number | bigint, toBlock: number | bigint) => {
    if (failNextGetLogs) {
      failNextGetLogs = false;
      return Promise.reject(new Error("transient RPC blip"));
    }
    return Promise.resolve(chain.logsInRange(Number(fromBlock), Number(toBlock)));
  });
  const client: RpcClient = {
    getChainId: vi.fn().mockResolvedValue(1),
    getLatestBlock: vi.fn(() => Promise.resolve(chain.asBlock(latest.current))),
    getBlock: vi.fn((n: number | bigint) => Promise.resolve(chain.asBlock(Number(n)))),
    getBlockByHash: vi.fn((hash: Hash) => Promise.resolve(chain.blockByHash(hash))),
    getLogs,
  };
  return { client, getLogs, failNextGetLogsOnce: () => (failNextGetLogs = true) };
}

/** Runs the real indexer loop for exactly one poll cycle, then stops — simulates one indexer
 * process lifetime (start, index what's available, exit), same pattern loop.test.ts uses. */
function runOneCycle(client: RpcClient, chainId: number): Promise<void> {
  const controller = new AbortController();
  return runIndexerLoop({
    client,
    db,
    chainId,
    indexerName: "events",
    startBlock: 498,
    chunkSize: 1, // force multiple ranges on the initial backfill, exercising historical indexing
    confirmations: 0,
    pollIntervalMs: 1000,
    signal: controller.signal,
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });
}

interface IntentBody {
  success: true;
  data: { status: string };
  indexedBlock: number | null;
}
interface FillsBody {
  success: true;
  data: { solver: string; amountOut: string }[];
}
interface SolverStateBody {
  success: true;
  data: { chainId: number; openIntents: number; filledIntents: number; cancelledIntents: number; totalFills: number };
}

beforeAll(setupTestDb);

describe("end-to-end: chain -> indexer -> Postgres -> API", () => {
  it("indexes IntentCreated/Cancelled/Filled, survives a restart, and recovers from a reorg", async () => {
    const chainId = randomChainId();
    const chain = makeMockChain();
    const latest = { current: 500 };
    const { client, getLogs, failNextGetLogsOnce } = makeRpcClient(chain, latest);

    // Redis is wired up but broken for the whole test — every cached API route below (solver
    // state, open intents) proves it still returns correct data straight from Postgres (see
    // packages/database/src/cache.ts's cache-aside fallback).
    const brokenRedis = {
      ping: vi.fn(() => Promise.reject(new Error("connection refused"))),
      get: vi.fn(() => Promise.reject(new Error("connection refused"))),
      set: vi.fn(() => Promise.reject(new Error("connection refused"))),
      del: vi.fn(() => Promise.reject(new Error("connection refused"))),
    } as unknown as RedisClient;
    const state: AppState = { initialized: false };
    const app = buildApp({ db, redis: brokenRedis, logLevel: "error", state, chainId });

    // --- application startup: not ready until bootstrap finishes, same as apps/api/src/index.ts ---
    await app.ready();
    const notReady = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(notReady.statusCode).toBe(503);
    state.initialized = true;

    // --- Redis failure: readiness correctly fails closed on a down dependency (database is fine,
    // redis isn't) — while individual cached read routes (checked throughout below) degrade to
    // the database instead of failing. ---
    const readyResponse = await app.inject({ method: "GET", url: "/api/v1/ready" });
    expect(readyResponse.statusCode).toBe(503);
    expect(readyResponse.json<{ data: { checks: { database: boolean; redis: boolean; initialized: boolean } } }>().data.checks).toEqual(
      { database: true, redis: false, initialized: true },
    );

    // --- database migration: runMigrations (via setupTestDb) actually applied the schema ---
    const migrationRows = await db.$client`select 1 from drizzle.__drizzle_migrations limit 1`;
    expect(migrationRows.length).toBeGreaterThan(0);

    // --- historical indexing + IntentCreated + IntentCreated (for the cancel path) ---
    // Blocks 498-499 are pre-existing chain history with no relevant logs; block 500 carries
    // both intents' creation events. chunkSize:1 in runOneCycle forces this backfill into three
    // separate ranges, each its own committed checkpoint step.
    chain.setBlock(498, { hash: "0xB498", parentHash: "0xGENESIS", logs: [] });
    chain.setBlock(499, { hash: "0xB499", parentHash: "0xB498", logs: [] });
    chain.setBlock(500, {
      hash: "0xB500",
      parentHash: "0xB499",
      logs: [
        makeLog({
          blockNumber: 500,
          blockHash: "0xB500",
          txHash: "0xtxCreate500a",
          logIndex: 0,
          eventName: "IntentCreated",
          args: {
            intentId: INTENT_ID,
            owner: OWNER,
            tokenIn: TOKEN_IN,
            tokenOut: TOKEN_OUT,
            amountIn: 1_000n,
            minAmountOut: 900n,
            deadline: 9_999_999_999n,
          },
        }),
        makeLog({
          blockNumber: 500,
          blockHash: "0xB500",
          txHash: "0xtxCreate500b",
          logIndex: 1,
          eventName: "IntentCreated",
          args: {
            intentId: INTENT_ID_CANCELLED,
            owner: OWNER,
            tokenIn: TOKEN_IN,
            tokenOut: TOKEN_OUT,
            amountIn: 500n,
            minAmountOut: 400n,
            deadline: 9_999_999_999n,
          },
        }),
      ],
    });

    await runOneCycle(client, chainId);

    expect(await getIntent(db, chainId, INTENT_ID)).toMatchObject({ status: IntentStatus.OPEN });

    // --- API query: OPEN intent visible right after indexing ---
    const openAfterCreate = await app.inject({ method: "GET", url: `/api/v1/intents/${INTENT_ID}` });
    expect(openAfterCreate.statusCode).toBe(200);
    expect(openAfterCreate.json<IntentBody>().data.status).toBe("OPEN");
    expect(openAfterCreate.json<IntentBody>().indexedBlock).toBe(500);

    // --- duplicate event processing: replaying an already-indexed range is a no-op ---
    await runIndexingPipeline(client, db, chainId, 498, 500, 1000);
    expect(await countIntentsByStatus(db, chainId)).toEqual({ [IntentStatus.OPEN]: 2 });

    // --- RPC failure/retry: one transient getLogs failure is absorbed without corrupting state ---
    failNextGetLogsOnce();

    // --- IntentFilled + IntentCancelled, one block later ---
    latest.current = 501;
    chain.setBlock(501, {
      hash: "0xB501",
      parentHash: "0xB500",
      logs: [
        makeLog({
          blockNumber: 501,
          blockHash: "0xB501",
          txHash: "0xtxFill501",
          logIndex: 0,
          eventName: "IntentFilled",
          args: { intentId: INTENT_ID, solver: SOLVER, amountIn: 1_000n, amountOut: 950n },
        }),
        makeLog({
          blockNumber: 501,
          blockHash: "0xB501",
          txHash: "0xtxCancel501",
          logIndex: 1,
          eventName: "IntentCancelled",
          args: { intentId: INTENT_ID_CANCELLED, owner: OWNER },
        }),
      ],
    });

    // First cycle after the injected failure is retried internally by the RPC client (see
    // apps/indexer/src/rpc/retry.ts) and still completes within this one call. Clearing history
    // first isolates this cycle's calls from the backfill/duplicate-check calls above.
    getLogs.mockClear();
    await runOneCycle(client, chainId);
    // one failed attempt + one retry, both for the new range only — [498,500] is never re-fetched
    // on restart, proving checkpoint resumption skips already-indexed history.
    expect(getLogs.mock.calls.map(([from, to]) => [Number(from), Number(to)])).toEqual([
      [501, 501],
      [501, 501],
    ]);

    // --- domain projection + API query: FILLED, with the fill recorded ---
    expect(await getIntent(db, chainId, INTENT_ID)).toMatchObject({ status: IntentStatus.FILLED });
    const filledResponse = await app.inject({ method: "GET", url: `/api/v1/intents/${INTENT_ID}` });
    expect(filledResponse.json<IntentBody>().data.status).toBe("FILLED");
    const fillsResponse = await app.inject({ method: "GET", url: `/api/v1/intents/${INTENT_ID}/fills` });
    expect(fillsResponse.json<FillsBody>().data).toEqual([
      expect.objectContaining({ solver: getAddress(SOLVER), amountOut: "950" }),
    ]);
    const cancelledResponse = await app.inject({ method: "GET", url: `/api/v1/intents/${INTENT_ID_CANCELLED}` });
    expect(cancelledResponse.json<IntentBody>().data.status).toBe("CANCELLED");

    // --- checkpoint persistence + restart recovery: re-running the loop with nothing new to
    // index touches neither getLogs nor the checkpoint ---
    getLogs.mockClear();
    await runOneCycle(client, chainId);
    expect(getLogs).not.toHaveBeenCalled();
    expect(await countFills(db, chainId)).toBe(1);

    // --- solver state endpoint, pre-reorg ---
    const solverBeforeReorg = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(solverBeforeReorg.json<SolverStateBody>().data).toEqual({
      chainId,
      openIntents: 0,
      filledIntents: 1,
      cancelledIntents: 1,
      totalFills: 1,
    });

    // --- reorg recovery: block 501 is replaced on-chain; a new block 502 becomes canonical ---
    chain.setBlock(501, { hash: "0xB501b", parentHash: "0xB500", logs: [] });
    chain.setBlock(502, {
      hash: "0xB502",
      parentHash: "0xB501b",
      logs: [
        makeLog({
          blockNumber: 502,
          blockHash: "0xB502",
          txHash: "0xtxCreate502",
          logIndex: 0,
          eventName: "IntentCreated",
          args: {
            intentId: INTENT_ID_POST_REORG,
            owner: OWNER,
            tokenIn: TOKEN_IN,
            tokenOut: TOKEN_OUT,
            amountIn: 2_000n,
            minAmountOut: 1_800n,
            deadline: 9_999_999_999n,
          },
        }),
      ],
    });
    latest.current = 502;

    await runOneCycle(client, chainId);

    // old canonical block 501 (the fill/cancel block) is now marked non-canonical...
    expect(await getBlockByHash(db, chainId, "0xB501")).toMatchObject({ isCanonical: false });
    expect(await getEvent(db, chainId, "0xtxFill501", 0)).toMatchObject({ isCanonical: false });
    // ...the new block 501 is canonical...
    expect(await getBlockByHash(db, chainId, "0xB501b")).toMatchObject({ isCanonical: true });
    // ...the reorged-out fill and cancellation are undone (state reverts to OPEN)...
    expect(await getIntent(db, chainId, INTENT_ID)).toMatchObject({ status: IntentStatus.OPEN });
    expect(await getIntent(db, chainId, INTENT_ID_CANCELLED)).toMatchObject({ status: IntentStatus.OPEN });
    expect(await countFills(db, chainId)).toBe(0);
    // ...and the new canonical chain's intent is indexed.
    expect(await getIntent(db, chainId, INTENT_ID_POST_REORG)).toMatchObject({ status: IntentStatus.OPEN });

    // --- API query + solver state, post-reorg: reflects the new canonical state ---
    const reopenedResponse = await app.inject({ method: "GET", url: `/api/v1/intents/${INTENT_ID}` });
    expect(reopenedResponse.json<IntentBody>().data.status).toBe("OPEN");
    const openIntentsResponse = await app.inject({ method: "GET", url: "/api/v1/intents?status=OPEN" });
    expect(openIntentsResponse.json<{ data: { intentId: string }[] }>().data.map((i) => i.intentId).sort()).toEqual(
      [INTENT_ID, INTENT_ID_CANCELLED, INTENT_ID_POST_REORG].sort(),
    );
    const solverAfterReorg = await app.inject({ method: "GET", url: "/api/v1/solver/state" });
    expect(solverAfterReorg.json<SolverStateBody>().data).toEqual({
      chainId,
      openIntents: 3,
      filledIntents: 0,
      cancelledIntents: 0,
      totalFills: 0,
    });
  });
});
