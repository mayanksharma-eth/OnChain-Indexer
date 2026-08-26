import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain } from "./chains.js";
import { getCheckpoint, saveCheckpoint } from "./checkpoints.js";

beforeEach(async () => {
  await setupTestDb();
  await createChain(db, { chainId: 1, name: "Ethereum" });
});

describe("indexer_checkpoints repository", () => {
  it("creates a checkpoint on first save", async () => {
    await saveCheckpoint(db, {
      chainId: 1,
      indexerName: "events",
      lastProcessedBlock: 100,
      lastProcessedBlockHash: "0xblock100",
    });

    const checkpoint = await getCheckpoint(db, 1, "events");
    expect(checkpoint?.lastProcessedBlock).toBe(100);
  });

  it("updates in place on a subsequent save for the same (chain_id, indexer_name)", async () => {
    await saveCheckpoint(db, {
      chainId: 1,
      indexerName: "events",
      lastProcessedBlock: 100,
      lastProcessedBlockHash: "0xblock100",
    });
    await saveCheckpoint(db, {
      chainId: 1,
      indexerName: "events",
      lastProcessedBlock: 200,
      lastProcessedBlockHash: "0xblock200",
    });

    const checkpoint = await getCheckpoint(db, 1, "events");
    expect(checkpoint?.lastProcessedBlock).toBe(200);
  });

  it("tracks independent checkpoints per indexer name", async () => {
    await saveCheckpoint(db, {
      chainId: 1,
      indexerName: "events",
      lastProcessedBlock: 100,
      lastProcessedBlockHash: "0xa",
    });
    await saveCheckpoint(db, {
      chainId: 1,
      indexerName: "fills",
      lastProcessedBlock: 50,
      lastProcessedBlockHash: "0xb",
    });

    expect((await getCheckpoint(db, 1, "events"))?.lastProcessedBlock).toBe(100);
    expect((await getCheckpoint(db, 1, "fills"))?.lastProcessedBlock).toBe(50);
  });

  it("returns undefined for a checkpoint that has never been saved", async () => {
    expect(await getCheckpoint(db, 1, "unknown")).toBeUndefined();
  });
});
