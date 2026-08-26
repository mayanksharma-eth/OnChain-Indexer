import { eq } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { chains, type Chain, type NewChain } from "../schema.js";

export async function createChain(db: DbOrTx, values: NewChain): Promise<Chain> {
  const [row] = await db.insert(chains).values(values).returning();
  if (!row) throw new Error("failed to create chain");
  return row;
}

export async function getChainByChainId(db: DbOrTx, chainId: number): Promise<Chain | undefined> {
  const [row] = await db.select().from(chains).where(eq(chains.chainId, chainId));
  return row;
}

export async function listChains(db: DbOrTx): Promise<Chain[]> {
  return db.select().from(chains);
}

export async function updateChainProgress(
  db: DbOrTx,
  chainId: number,
  progress: Partial<Pick<NewChain, "latestBlock" | "indexedBlock">>,
): Promise<Chain | undefined> {
  const [row] = await db
    .update(chains)
    .set({ ...progress, updatedAt: new Date() })
    .where(eq(chains.chainId, chainId))
    .returning();
  return row;
}

export async function deleteChain(db: DbOrTx, chainId: number): Promise<void> {
  await db.delete(chains).where(eq(chains.chainId, chainId));
}
