import { describe, expect, it } from "vitest";
import { createChain, getCheckpoint } from "@onchain-indexer/database";
import { db, randomChainId, setupTestDb } from "../pipeline/test-setup.js";
import { advanceCheckpoint, loadStartBlock } from "./checkpoint-service.js";

describe("checkpoint service", () => {
  it("on first startup, with no checkpoint saved, resumes from the configured start block", async () => {
    await setupTestDb();
    const chainId = randomChainId();

    const startBlock = await loadStartBlock(db, { chainId, indexerName: "events" }, 1234);

    expect(startBlock).toBe(1234);
  });

  it("saving the same checkpoint value twice is idempotent, not an error or a duplicate row", async () => {
    await setupTestDb();
    const chainId = randomChainId();
    await createChain(db, { chainId, name: `chain-${chainId}` });
    const identity = { chainId, indexerName: "events" };
    const value = { blockNumber: 1499, blockHash: "0xblock1499" };

    await advanceCheckpoint(db, identity, value);
    await advanceCheckpoint(db, identity, value);

    const checkpoint = await getCheckpoint(db, chainId, "events");
    expect(checkpoint).toMatchObject({ lastProcessedBlock: 1499, lastProcessedBlockHash: "0xblock1499" });
  });
});
