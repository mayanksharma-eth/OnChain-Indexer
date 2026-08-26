import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createChain, saveCheckpoint } from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../test-setup.js";
import { buildTestApp } from "../test-app.js";

interface IndexerStatusBody {
  success: true;
  data: {
    chainId: number;
    indexerName: string;
    indexedBlock: number | null;
    indexedBlockHash: string | null;
    updatedAt: string | null;
  };
  indexedBlock: number | null;
}

let chainId: number;
let app: FastifyInstance;

beforeAll(setupTestDb);

beforeEach(async () => {
  chainId = randomChainId();
  await createChain(db, { chainId, name: `chain-${chainId}` });
  app = buildTestApp(chainId);
});

describe("GET /api/v1/indexer/status", () => {
  it("reports nulls before any checkpoint has been saved", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/indexer/status" });

    expect(response.statusCode).toBe(200);
    const body = response.json<IndexerStatusBody>();
    expect(body.data).toEqual({
      chainId,
      indexerName: "events",
      indexedBlock: null,
      indexedBlockHash: null,
      updatedAt: null,
    });
    expect(body.indexedBlock).toBeNull();
  });

  it("reflects the persisted checkpoint", async () => {
    await saveCheckpoint(db, {
      chainId,
      indexerName: "events",
      lastProcessedBlock: 12_345_678,
      lastProcessedBlockHash: "0xblockhash",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/indexer/status" });

    const body = response.json<IndexerStatusBody>();
    expect(body.data.indexedBlock).toBe(12_345_678);
    expect(body.data.indexedBlockHash).toBe("0xblockhash");
    expect(typeof body.data.updatedAt).toBe("string");
    expect(body.indexedBlock).toBe(12_345_678);
  });

  it("does not reflect another chain's checkpoint", async () => {
    const otherChainId = randomChainId();
    await createChain(db, { chainId: otherChainId, name: `chain-${otherChainId}` });
    await saveCheckpoint(db, {
      chainId: otherChainId,
      indexerName: "events",
      lastProcessedBlock: 1,
      lastProcessedBlockHash: "0xother",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/indexer/status" });

    expect(response.json<IndexerStatusBody>().data.indexedBlock).toBeNull();
  });
});
