import { describe, expect, it } from "vitest";
import { loadIndexerConfig } from "./indexer.js";
import { loadApiConfig } from "./api.js";

const validEnv = {
  NODE_ENV: "test",
  RPC_URL: "https://eth.llamarpc.com",
  CHAIN_ID: "1",
  CONTRACT_ADDRESS: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  INDEXER_START_BLOCK: "100",
  INDEXER_CHUNK_SIZE: "500",
  INDEXER_POLL_INTERVAL_MS: "2000",
  CONFIRMATIONS: "3",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/onchain_indexer",
  REDIS_URL: "redis://localhost:6379",
  API_PORT: "3000",
  LOG_LEVEL: "info",
};

describe("loadIndexerConfig", () => {
  it("parses a valid environment into typed config", () => {
    const config = loadIndexerConfig(validEnv);
    expect(config.RPC_URL).toBe(validEnv.RPC_URL);
    expect(config.CHAIN_ID).toBe(1);
    expect(config.INDEXER_START_BLOCK).toBe(100);
    expect(config.INDEXER_CHUNK_SIZE).toBe(500);
    expect(config.INDEXER_POLL_INTERVAL_MS).toBe(2000);
    expect(config.CONFIRMATIONS).toBe(3);
  });

  it("applies sensible development defaults when optional vars are omitted", () => {
    const { RPC_URL, CONTRACT_ADDRESS, DATABASE_URL, REDIS_URL } = validEnv;
    const config = loadIndexerConfig({ RPC_URL, CONTRACT_ADDRESS, DATABASE_URL, REDIS_URL });
    expect(config.NODE_ENV).toBe("development");
    expect(config.CHAIN_ID).toBe(31337);
    expect(config.INDEXER_START_BLOCK).toBe(0);
    expect(config.INDEXER_CHUNK_SIZE).toBe(2000);
    expect(config.INDEXER_POLL_INTERVAL_MS).toBe(4000);
    expect(config.CONFIRMATIONS).toBe(5);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("fails clearly when RPC_URL is missing", () => {
    const { RPC_URL: _RPC_URL, ...rest } = validEnv;
    expect(() => loadIndexerConfig(rest)).toThrowError(/RPC_URL/);
  });

  it("fails clearly when CONTRACT_ADDRESS is missing or malformed", () => {
    const { CONTRACT_ADDRESS: _CONTRACT_ADDRESS, ...rest } = validEnv;
    expect(() => loadIndexerConfig(rest)).toThrowError(/CONTRACT_ADDRESS/);
    expect(() => loadIndexerConfig({ ...validEnv, CONTRACT_ADDRESS: "not-an-address" })).toThrowError(
      /CONTRACT_ADDRESS/,
    );
  });

  it("fails when CHAIN_ID is invalid", () => {
    expect(() => loadIndexerConfig({ ...validEnv, CHAIN_ID: "not-a-number" })).toThrowError(
      /CHAIN_ID/,
    );
    expect(() => loadIndexerConfig({ ...validEnv, CHAIN_ID: "-1" })).toThrowError(/CHAIN_ID/);
  });

  it("fails when numeric fields are invalid", () => {
    expect(() =>
      loadIndexerConfig({ ...validEnv, INDEXER_CHUNK_SIZE: "not-a-number" }),
    ).toThrowError(/INDEXER_CHUNK_SIZE/);
    expect(() => loadIndexerConfig({ ...validEnv, CONFIRMATIONS: "-3" })).toThrowError(
      /CONFIRMATIONS/,
    );
    expect(() =>
      loadIndexerConfig({ ...validEnv, INDEXER_POLL_INTERVAL_MS: "0" }),
    ).toThrowError(/INDEXER_POLL_INTERVAL_MS/);
  });

  it("fails when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validEnv;
    expect(() => loadIndexerConfig(rest)).toThrowError(/DATABASE_URL/);
  });

  it("REDIS_URL is optional — Redis is a cache-aside layer, not the source of truth", () => {
    const { REDIS_URL: _REDIS_URL, ...rest } = validEnv;
    const config = loadIndexerConfig(rest);
    expect(config.REDIS_URL).toBeUndefined();
  });
});

describe("loadApiConfig", () => {
  it("parses a valid environment, keeping CHAIN_ID but omitting indexer-only fields", () => {
    const config = loadApiConfig(validEnv);
    expect(config.API_PORT).toBe(3000);
    expect(config.CHAIN_ID).toBe(1);
    expect("RPC_URL" in config).toBe(false);
  });

  it("applies sensible defaults for API_PORT and CHAIN_ID", () => {
    const { DATABASE_URL, REDIS_URL } = validEnv;
    const config = loadApiConfig({ DATABASE_URL, REDIS_URL });
    expect(config.API_PORT).toBe(3000);
    expect(config.CHAIN_ID).toBe(31337);
  });

  it("fails when CHAIN_ID is invalid", () => {
    expect(() => loadApiConfig({ ...validEnv, CHAIN_ID: "not-a-number" })).toThrowError(
      /CHAIN_ID/,
    );
  });

  it("fails when API_PORT is out of range", () => {
    expect(() => loadApiConfig({ ...validEnv, API_PORT: "70000" })).toThrowError(/API_PORT/);
    expect(() => loadApiConfig({ ...validEnv, API_PORT: "not-a-number" })).toThrowError(
      /API_PORT/,
    );
  });

  it("fails clearly when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validEnv;
    expect(() => loadApiConfig(rest)).toThrowError(/DATABASE_URL/);
  });
});
