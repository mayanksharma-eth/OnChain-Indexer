import { describe, expect, it, vi } from "vitest";
import { createRpcClient } from "./client.js";
import { ChainIdMismatchError, RpcRetriesExhaustedError } from "./errors.js";
import type { MinimalPublicClient } from "./client.js";

const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

function fakePublicClient(overrides: Partial<MinimalPublicClient> = {}): MinimalPublicClient {
  return {
    getChainId: vi.fn().mockResolvedValue(31337),
    getBlock: vi.fn(),
    getLogs: vi.fn(),
    ...overrides,
  };
}

describe("createRpcClient", () => {
  it("validates the chain ID at startup, then serves getLatestBlock/getBlock/getBlockByHash/getLogs/getChainId", async () => {
    const block = { number: 100n, hash: "0xblock" };
    const publicClient = fakePublicClient({
      getBlock: vi.fn().mockResolvedValue(block),
      getLogs: vi.fn().mockResolvedValue([]),
    });

    const client = await createRpcClient(
      { rpcUrl: "http://rpc.local", chainId: 31337, contractAddress: CONTRACT },
      { publicClient },
    );

    expect(await client.getChainId()).toBe(31337);

    expect(await client.getLatestBlock()).toEqual(block);
    expect(publicClient.getBlock).toHaveBeenCalledWith();

    expect(await client.getBlock(100)).toEqual(block);
    expect(publicClient.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });

    expect(await client.getBlockByHash("0xhash")).toEqual(block);
    expect(publicClient.getBlock).toHaveBeenCalledWith({ blockHash: "0xhash" });

    expect(await client.getLogs(1, 10)).toEqual([]);
    expect(publicClient.getLogs).toHaveBeenCalledWith({ address: CONTRACT, fromBlock: 1n, toBlock: 10n });
  });

  it("throws a structured ChainIdMismatchError when the RPC endpoint reports a different chain ID", async () => {
    const publicClient = fakePublicClient({ getChainId: vi.fn().mockResolvedValue(1) });

    await expect(
      createRpcClient({ rpcUrl: "http://rpc.local", chainId: 31337, contractAddress: CONTRACT }, { publicClient }),
    ).rejects.toThrow(ChainIdMismatchError);
  });

  it("surfaces a single RPC failure as a structured error when no retries are configured", async () => {
    const failure = new Error("connection refused");
    const publicClient = fakePublicClient({ getLogs: vi.fn().mockRejectedValue(failure) });

    const client = await createRpcClient(
      { rpcUrl: "http://rpc.local", chainId: 31337, contractAddress: CONTRACT, maxRetries: 0, baseDelayMs: 1 },
      { publicClient },
    );

    await expect(client.getLogs(1, 2)).rejects.toThrow(RpcRetriesExhaustedError);
    expect(publicClient.getLogs).toHaveBeenCalledTimes(1);
  });

  it("retries a failing request with exponential backoff and returns the eventual success", async () => {
    const getBlock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ number: 1n });
    const publicClient = fakePublicClient({ getBlock });

    const start = Date.now();
    const client = await createRpcClient(
      { rpcUrl: "http://rpc.local", chainId: 31337, contractAddress: CONTRACT, maxRetries: 3, baseDelayMs: 10 },
      { publicClient },
    );

    const block = await client.getBlock(1);

    expect(block).toEqual({ number: 1n });
    expect(getBlock).toHaveBeenCalledTimes(3);
    // two backoff sleeps of 10ms and 20ms should have elapsed
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it("throws RpcRetriesExhaustedError with the underlying error as cause once retries are exhausted", async () => {
    const failure = new Error("rpc down");
    const publicClient = fakePublicClient({ getBlock: vi.fn().mockRejectedValue(failure) });

    const client = await createRpcClient(
      { rpcUrl: "http://rpc.local", chainId: 31337, contractAddress: CONTRACT, maxRetries: 2, baseDelayMs: 1 },
      { publicClient },
    );

    await expect(client.getBlock(1)).rejects.toThrow(RpcRetriesExhaustedError);
    expect(publicClient.getBlock).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries

    try {
      await client.getBlock(1);
      expect.unreachable("expected getBlock to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcRetriesExhaustedError);
      expect((error as Error).cause).toBe(failure);
    }
  });
});
