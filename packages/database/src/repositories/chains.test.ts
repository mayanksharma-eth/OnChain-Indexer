import { beforeEach, describe, expect, it } from "vitest";
import { db, setupTestDb } from "./test-setup.js";
import { createChain, deleteChain, getChainByChainId, listChains, updateChainProgress } from "./chains.js";

beforeEach(setupTestDb);

describe("chains repository", () => {
  it("creates and retrieves a chain by chain_id", async () => {
    await createChain(db, { chainId: 1, name: "Ethereum" });

    const chain = await getChainByChainId(db, 1);
    expect(chain?.name).toBe("Ethereum");
    expect(chain?.latestBlock).toBe(0);
    expect(chain?.indexedBlock).toBe(0);
  });

  it("returns undefined for an unknown chain", async () => {
    expect(await getChainByChainId(db, 999)).toBeUndefined();
  });

  it("rejects a duplicate chain_id", async () => {
    await createChain(db, { chainId: 1, name: "Ethereum" });
    await expect(createChain(db, { chainId: 1, name: "Duplicate" })).rejects.toThrow();
  });

  it("lists all chains", async () => {
    await createChain(db, { chainId: 1, name: "Ethereum" });
    await createChain(db, { chainId: 137, name: "Polygon" });

    const all = await listChains(db);
    expect(all.map((c) => c.chainId).sort()).toEqual([1, 137]);
  });

  it("updates indexing progress", async () => {
    await createChain(db, { chainId: 1, name: "Ethereum" });

    const updated = await updateChainProgress(db, 1, { latestBlock: 100, indexedBlock: 90 });
    expect(updated?.latestBlock).toBe(100);
    expect(updated?.indexedBlock).toBe(90);
  });

  it("deletes a chain", async () => {
    await createChain(db, { chainId: 1, name: "Ethereum" });
    await deleteChain(db, 1);

    expect(await getChainByChainId(db, 1)).toBeUndefined();
  });
});
