import { afterAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { cached, cacheKeys, invalidateChainCache } from "./cache.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL);

afterAll(async () => {
  await redis.quit();
});

function randomKey(): string {
  return `test:cache:${Math.random().toString(36).slice(2)}`;
}

describe("cached (cache-aside)", () => {
  it("is a miss on an empty key: calls the fetcher and populates the cache", async () => {
    const key = randomKey();
    const fetcher = vi.fn(() => Promise.resolve({ value: 42 }));

    const result = await cached(redis, key, 10, fetcher);

    expect(result).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await redis.get(key)) ?? "null")).toEqual({ value: 42 });
  });

  it("is a hit when the key is already cached: returns it without calling the fetcher", async () => {
    const key = randomKey();
    await redis.set(key, JSON.stringify({ value: 7 }), "EX", 10);
    const fetcher = vi.fn(() => Promise.resolve({ value: 999 }));

    const result = await cached(redis, key, 10, fetcher);

    expect(result).toEqual({ value: 7 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("expires: re-calls the fetcher once the TTL has elapsed", async () => {
    const key = randomKey();
    let calls = 0;
    const fetcher = vi.fn(() => Promise.resolve({ value: ++calls }));

    const first = await cached(redis, key, 1, fetcher);
    expect(first).toEqual({ value: 1 });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await cached(redis, key, 1, fetcher);
    expect(second).toEqual({ value: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to the fetcher without throwing when Redis is unavailable", async () => {
    const brokenRedis = {
      get: vi.fn(() => Promise.reject(new Error("connection refused"))),
      set: vi.fn(() => Promise.reject(new Error("connection refused"))),
    } as unknown as Redis;
    const fetcher = vi.fn(() => Promise.resolve("source-of-truth"));

    const result = await cached(brokenRedis, randomKey(), 10, fetcher);

    expect(result).toBe("source-of-truth");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("calls the fetcher directly when Redis is not configured (null)", async () => {
    const fetcher = vi.fn(() => Promise.resolve("no-redis"));

    const result = await cached(null, randomKey(), 10, fetcher);

    expect(result).toBe("no-redis");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports hit/miss through the optional logger", async () => {
    const key = randomKey();
    const events: Array<["hit" | "miss", string]> = [];
    const onLog = (event: "hit" | "miss", loggedKey: string) => events.push([event, loggedKey]);

    await cached(redis, key, 10, () => Promise.resolve("value"), onLog);
    await cached(redis, key, 10, () => Promise.resolve("value"), onLog);

    expect(events).toEqual([
      ["miss", key],
      ["hit", key],
    ]);
  });
});

describe("invalidateChainCache", () => {
  it("deletes all cached keys for the chain", async () => {
    const chainId = Math.floor(Math.random() * 1_000_000) + 500_000;
    await redis.set(cacheKeys.solverState(chainId), "stale", "EX", 10);
    await redis.set(cacheKeys.openIntents(chainId), "stale", "EX", 10);
    await redis.set(cacheKeys.indexerStatus(chainId), "stale", "EX", 10);

    await invalidateChainCache(redis, chainId);

    expect(await redis.get(cacheKeys.solverState(chainId))).toBeNull();
    expect(await redis.get(cacheKeys.openIntents(chainId))).toBeNull();
    expect(await redis.get(cacheKeys.indexerStatus(chainId))).toBeNull();
  });

  it("does not throw when Redis is unavailable", async () => {
    const brokenRedis = { del: vi.fn(() => Promise.reject(new Error("down"))) } as unknown as Redis;

    await expect(invalidateChainCache(brokenRedis, 1)).resolves.toBeUndefined();
  });

  it("is a no-op when Redis is not configured (null)", async () => {
    await expect(invalidateChainCache(null, 1)).resolves.toBeUndefined();
  });
});
