import { describe, expect, it, vi } from "vitest";
import type { Database } from "@onchain-indexer/database";
import { buildApp } from "./app.js";
import type { RedisClient } from "./lib/http.js";

interface ReadyBody {
  data: {
    status: "ready" | "not_ready";
    checks: { database: boolean; redis: boolean | null; initialized: boolean };
  };
}

function fakeDb(shouldFail = false): Database {
  return {
    execute: vi.fn(() => (shouldFail ? Promise.reject(new Error("db down")) : Promise.resolve([]))),
  } as unknown as Database;
}

function fakeRedis(shouldFail = false): RedisClient {
  return {
    ping: vi.fn(() => (shouldFail ? Promise.reject(new Error("redis down")) : Promise.resolve("PONG"))),
  } as unknown as RedisClient;
}

describe("GET /api/v1/health", () => {
  it("reports the process alive without checking dependencies", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: true }, chainId: 1 });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { status: "ok" } });
  });
});

describe("GET /api/v1/ready", () => {
  it("returns 200 when postgres, redis and the app are all ready", async () => {
    const app = buildApp({
      db: fakeDb(),
      redis: fakeRedis(),
      logLevel: "error",
      state: { initialized: true },
      chainId: 1,
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { status: "ready", checks: { database: true, redis: true, initialized: true } },
    });
  });

  it("returns 503 when postgres is unreachable", async () => {
    const app = buildApp({
      db: fakeDb(true),
      redis: fakeRedis(),
      logLevel: "error",
      state: { initialized: true },
      chainId: 1,
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadyBody>().data.checks.database).toBe(false);
  });

  it("returns 503 when redis is configured but unreachable", async () => {
    const app = buildApp({
      db: fakeDb(),
      redis: fakeRedis(true),
      logLevel: "error",
      state: { initialized: true },
      chainId: 1,
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadyBody>().data.checks.redis).toBe(false);
  });

  it("treats redis as not applicable when it isn't configured", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: true }, chainId: 1 });
    const response = await app.inject({ method: "GET", url: "/api/v1/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReadyBody>().data.checks.redis).toBeNull();
  });

  it("returns 503 while the app has not finished initializing", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: false }, chainId: 1 });
    const response = await app.inject({ method: "GET", url: "/api/v1/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadyBody>().data.checks.initialized).toBe(false);
  });
});

describe("GET /metrics", () => {
  it("exposes request counters and duration in Prometheus text format", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: true }, chainId: 1 });
    await app.inject({ method: "GET", url: "/api/v1/health" });
    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("api_requests_total");
    expect(response.body).toContain("api_request_duration_seconds");
    expect(response.body).toContain('route="/api/v1/health"');
  });
});

describe("error handling", () => {
  it("returns a consistent JSON envelope for unknown routes", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: true }, chainId: 1 });
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("does not expose health routes outside the /api/v1 prefix", async () => {
    const app = buildApp({ db: fakeDb(), redis: null, logLevel: "error", state: { initialized: true }, chainId: 1 });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(404);
  });
});
