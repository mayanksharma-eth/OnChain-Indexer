import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Block } from "viem";
import { getCheckpoint } from "@onchain-indexer/database";
import { logger } from "@onchain-indexer/utils";
import type { RpcClient } from "../rpc/client.js";
import { runIndexerLoop } from "./loop.js";
import { db, randomChainId, setupTestDb } from "../pipeline/test-setup.js";

beforeAll(setupTestDb);

function fakeBlock(number: number, hash = `0xblock${number}`): Block {
  return {
    number: BigInt(number),
    hash,
    parentHash: `0xparent${number}`,
    timestamp: 1_700_000_000n,
  } as unknown as Block;
}

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getChainId: vi.fn().mockResolvedValue(31337),
    getLatestBlock: vi.fn(),
    getBlock: vi.fn((n: number | bigint) => Promise.resolve(fakeBlock(Number(n)))),
    getBlockByHash: vi.fn(),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Aborts the controller after `stopAfter` calls, otherwise resolves immediately (no real delay). */
function sleepThatStopsAfter(controller: AbortController, stopAfter: number) {
  let calls = 0;
  return vi.fn(() => {
    calls++;
    if (calls >= stopAfter) controller.abort();
    return Promise.resolve();
  });
}

describe("runIndexerLoop", () => {
  it("indexes up to safeBlock (latest - confirmations), never past it", async () => {
    const chainId = randomChainId();
    const getLogs = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ getLatestBlock: vi.fn().mockResolvedValue(fakeBlock(510)), getLogs });
    const controller = new AbortController();

    await runIndexerLoop({
      client,
      db,
      chainId,
      indexerName: "events",
      startBlock: 500,
      chunkSize: 1000,
      confirmations: 5,
      pollIntervalMs: 1000,
      signal: controller.signal,
      sleep: sleepThatStopsAfter(controller, 1),
    });

    expect(getLogs).toHaveBeenCalledWith(500, 505);
    const checkpoint = await getCheckpoint(db, chainId, "events");
    expect(checkpoint).toMatchObject({ lastProcessedBlock: 505 });
  });

  it("does nothing and does not touch checkpoint when nothing has reached confirmations yet", async () => {
    const chainId = randomChainId();
    const getLogs = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ getLatestBlock: vi.fn().mockResolvedValue(fakeBlock(502)), getLogs });
    const controller = new AbortController();

    await runIndexerLoop({
      client,
      db,
      chainId,
      indexerName: "events",
      startBlock: 500,
      chunkSize: 1000,
      confirmations: 10, // safeBlock = 492, below startBlock
      pollIntervalMs: 1000,
      signal: controller.signal,
      sleep: sleepThatStopsAfter(controller, 1),
    });

    expect(getLogs).not.toHaveBeenCalled();
    expect(await getCheckpoint(db, chainId, "events")).toBeUndefined();
  });

  it("recovers from a transient RPC failure without advancing or losing the checkpoint", async () => {
    const chainId = randomChainId();
    const getLatestBlock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient RPC blip"))
      .mockResolvedValueOnce(fakeBlock(505));
    const client = fakeClient({ getLatestBlock });
    const controller = new AbortController();
    const errorSpy = vi.spyOn(logger, "error");

    await runIndexerLoop({
      client,
      db,
      chainId,
      indexerName: "events",
      startBlock: 500,
      chunkSize: 1000,
      confirmations: 0,
      pollIntervalMs: 1000,
      signal: controller.signal,
      sleep: sleepThatStopsAfter(controller, 2),
    });

    const [message, meta] = errorSpy.mock.calls[0] ?? [];
    expect(message).toBe("poll cycle failed, will retry next poll interval");
    expect(String(meta?.error)).toContain("transient RPC blip");
    expect(getLatestBlock).toHaveBeenCalledTimes(2);
    const checkpoint = await getCheckpoint(db, chainId, "events");
    expect(checkpoint).toMatchObject({ lastProcessedBlock: 505 });
    errorSpy.mockRestore();
  });

  it("stops immediately without indexing when the signal is already aborted", async () => {
    const chainId = randomChainId();
    const getLatestBlock = vi.fn().mockResolvedValue(fakeBlock(510));
    const client = fakeClient({ getLatestBlock });
    const controller = new AbortController();
    controller.abort();

    await runIndexerLoop({
      client,
      db,
      chainId,
      indexerName: "events",
      startBlock: 500,
      chunkSize: 1000,
      confirmations: 5,
      pollIntervalMs: 1000,
      signal: controller.signal,
    });

    expect(getLatestBlock).not.toHaveBeenCalled();
  });

  it("logs checkpoint, latest block, safe block, lag, events processed, and duration each cycle", async () => {
    const chainId = randomChainId();
    const client = fakeClient({ getLatestBlock: vi.fn().mockResolvedValue(fakeBlock(510)) });
    const controller = new AbortController();
    const infoSpy = vi.spyOn(logger, "info");

    await runIndexerLoop({
      client,
      db,
      chainId,
      indexerName: "events",
      startBlock: 500,
      chunkSize: 1000,
      confirmations: 5,
      pollIntervalMs: 1000,
      signal: controller.signal,
      sleep: sleepThatStopsAfter(controller, 1),
    });

    const cycleCall = infoSpy.mock.calls.find(([message]) => message === "poll cycle complete");
    expect(cycleCall?.[1]).toMatchObject({
      checkpoint: null,
      latestBlock: 510,
      safeBlock: 505,
      blockLag: 10,
      eventsProcessed: 0,
    });
    expect(typeof cycleCall?.[1]?.durationMs).toBe("number");
    infoSpy.mockRestore();
  });
});
