import { describe, expect, it } from "vitest";
import { COW_SETTLEMENT_ADDRESS } from "@onchain-indexer/abi";
import { countCowSettlements, countCowTrades, getCheckpoint } from "@onchain-indexer/database";
import { createRpcClient } from "../../apps/indexer/src/rpc/index.js";
import { runCowIndexingPipeline } from "../../apps/indexer/src/pipeline/index.js";
import { buildApp } from "../../apps/api/src/app.js";
import { db, setupTestDb } from "./test-setup.js";

/**
 * REAL mainnet validation (Phase 9): connects to a real Ethereum RPC and indexes a real,
 * historical, already-final block range on the real GPv2Settlement contract — no mocked chain,
 * no fabricated events. Off by default (needs network + is non-deterministic RPC availability),
 * run explicitly with:
 *
 *   RUN_REAL_CHAIN_VALIDATION=1 pnpm vitest run tests/integration/cow-real-mainnet.test.ts
 *
 * Range chosen: blocks 21,000,000-21,000,030 on Ethereum mainnet. Verified via a free, no-API-key
 * archive RPC (eth.drpc.org — most free public RPCs, including the .env.example default, only
 * serve a recent-blocks window without an API key) to contain 9 Settlement + 11 Trade events
 * across 8 blocks, well past any possible reorg. See README.md's "Real CoW mainnet validation"
 * section for the full command to reproduce this against the live API.
 */
const REAL_RPC_URL = process.env.COW_VALIDATION_RPC_URL ?? "https://eth.drpc.org";
const START_BLOCK = 21_000_000;
const END_BLOCK = 21_000_030;
const CHAIN_ID = 1;
const INDEXER_NAME = "cow-events-real-validation";

describe.skipIf(!process.env.RUN_REAL_CHAIN_VALIDATION)("CoW adapter against real mainnet history", () => {
  it("indexes a real historical block range from a real RPC and serves it over the real API", async () => {
    await setupTestDb();

    const client = await createRpcClient({
      rpcUrl: REAL_RPC_URL,
      chainId: CHAIN_ID,
      contractAddress: COW_SETTLEMENT_ADDRESS,
    });

    const results = [];
    for await (const result of runCowIndexingPipeline(client, db, CHAIN_ID, START_BLOCK, END_BLOCK, 1000, {
      indexerName: INDEXER_NAME,
    })) {
      results.push(result);
    }

    const totalSettlements = results.reduce((sum, r) => sum + r.settlementsIndexed, 0);
    const totalTrades = results.reduce((sum, r) => sum + r.tradesIndexed, 0);
    // Confirmed against this exact range via direct eth_getLogs before writing this test —
    // see the README section referenced above.
    expect(totalSettlements).toBe(9);
    expect(totalTrades).toBe(11);

    const checkpoint = await getCheckpoint(db, CHAIN_ID, INDEXER_NAME);
    expect(checkpoint).toMatchObject({ lastProcessedBlock: END_BLOCK });

    expect(await countCowSettlements(db, CHAIN_ID)).toBeGreaterThanOrEqual(9);
    expect(await countCowTrades(db, CHAIN_ID)).toBeGreaterThanOrEqual(11);

    // Prove the full pipeline end-to-end: real RPC -> real contract event -> Postgres -> CoW
    // projection -> Fastify API response, not just direct repository reads.
    const app = buildApp({ db, redis: null, logLevel: "error", state: { initialized: true }, chainId: CHAIN_ID, nodeEnv: "test" });
    const statsResponse = await app.inject({ method: "GET", url: "/api/v1/cow/stats" });
    expect(statsResponse.statusCode).toBe(200);
    const stats = statsResponse.json<{ data: { totalSettlements: number; totalTrades: number } }>();
    expect(stats.data.totalSettlements).toBeGreaterThanOrEqual(9);
    expect(stats.data.totalTrades).toBeGreaterThanOrEqual(11);

    const settlementsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/cow/settlements?fromBlock=${START_BLOCK}&toBlock=${END_BLOCK}&limit=100`,
    });
    expect(settlementsResponse.statusCode).toBe(200);
    const settlementsBody = settlementsResponse.json<{ data: { transactionHash: string; solver: string }[] }>();
    expect(settlementsBody.data).toHaveLength(9);
  }, 60_000);
});
