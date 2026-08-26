import { describe, expect, it, vi } from "vitest";
import type { Log } from "viem";
import { fetchBlockRanges } from "./fetcher.js";
import { RpcRetriesExhaustedError } from "../rpc/errors.js";
import type { RpcClient } from "../rpc/client.js";

function fakeLog(overrides: Partial<Log> = {}): Log {
  return {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    data: "0x",
    topics: [],
    blockHash: "0xblock",
    blockNumber: 1000n,
    transactionHash: "0xtx",
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

function fakeClient(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getChainId: vi.fn().mockResolvedValue(31337),
    getLatestBlock: vi.fn(),
    getBlock: vi.fn().mockImplementation((n: number | bigint) => Promise.resolve({ number: BigInt(n) })),
    getBlockByHash: vi.fn(),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("fetchBlockRanges", () => {
  it("fetches logs and only the block metadata those logs reference, per range, in order", async () => {
    const getLogs = vi
      .fn()
      .mockResolvedValueOnce([fakeLog({ blockNumber: 1001n, logIndex: 1 }), fakeLog({ blockNumber: 1000n, logIndex: 0 })])
      .mockResolvedValueOnce([]);
    const getBlock = vi.fn().mockImplementation((n: number | bigint) => Promise.resolve({ number: BigInt(n) }));
    const client = fakeClient({ getLogs, getBlock });

    const results = await collect(fetchBlockRanges(client, 1000, 1999, 500));

    expect(results).toHaveLength(2);
    expect(results[0]!.range).toEqual({ fromBlock: 1000, toBlock: 1499 });
    expect(results[1]!.range).toEqual({ fromBlock: 1500, toBlock: 1999 });

    // deterministic ordering: logs sorted by blockNumber then logIndex, blocks deduped+sorted
    expect(results[0]!.blocks.map((b) => b.number)).toEqual([1000n, 1001n]);
    expect(getBlock).toHaveBeenCalledTimes(2);

    // second range had no logs, so no block metadata fetched
    expect(results[1]!.blocks).toEqual([]);

    expect(getLogs.mock.calls).toEqual([
      [1000, 1499],
      [1500, 1999],
    ]);
  });

  it("produces one range for a single-block query and fetches its block metadata once", async () => {
    const getBlock = vi.fn().mockResolvedValue({ number: 42n });
    const client = fakeClient({
      getLogs: vi.fn().mockResolvedValue([fakeLog({ blockNumber: 42n, logIndex: 0 })]),
      getBlock,
    });

    const results = await collect(fetchBlockRanges(client, 42, 42, 500));

    expect(results).toHaveLength(1);
    expect(results[0]!.range).toEqual({ fromBlock: 42, toBlock: 42 });
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid ranges before making any RPC calls", async () => {
    const getLogs = vi.fn();
    const client = fakeClient({ getLogs });

    await expect(collect(fetchBlockRanges(client, 100, 50, 10))).rejects.toThrow(RangeError);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("retries a range that fails transiently, then succeeds without skipping or reordering ranges", async () => {
    const getLogs = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient rpc blip"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const client = fakeClient({ getLogs });

    const results = await collect(fetchBlockRanges(client, 0, 999, 500, { maxRetries: 2, baseDelayMs: 1 }));

    expect(results.map((r) => r.range)).toEqual([
      { fromBlock: 0, toBlock: 499 },
      { fromBlock: 500, toBlock: 999 },
    ]);
    expect(getLogs).toHaveBeenCalledTimes(3);
  });

  it("surfaces a structured error once a range's retries are exhausted, without fetching later ranges", async () => {
    const getLogs = vi.fn().mockRejectedValue(new Error("rpc down"));
    const client = fakeClient({ getLogs });

    await expect(
      collect(fetchBlockRanges(client, 0, 999, 500, { maxRetries: 1, baseDelayMs: 1 })),
    ).rejects.toThrow(RpcRetriesExhaustedError);

    // only the first range was attempted (1 initial + 1 retry); the second range was never reached
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(getLogs).toHaveBeenCalledWith(0, 499);
  });
});
