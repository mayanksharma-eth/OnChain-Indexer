import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../postgres.js";
import { intents, type Intent, type NewIntent } from "../schema.js";

export async function createIntent(db: DbOrTx, values: NewIntent): Promise<Intent> {
  const [row] = await db.insert(intents).values(values).returning();
  if (!row) throw new Error("failed to create intent");
  return row;
}

export async function getIntent(
  db: DbOrTx,
  chainId: number,
  intentId: string,
): Promise<Intent | undefined> {
  const [row] = await db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.intentId, intentId)));
  return row;
}

export async function updateIntentStatus(
  db: DbOrTx,
  chainId: number,
  intentId: string,
  update: { status: string; updatedBlock: number; updatedTxHash: string },
): Promise<Intent | undefined> {
  const [row] = await db
    .update(intents)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(intents.chainId, chainId), eq(intents.intentId, intentId)))
    .returning();
  return row;
}

export async function listOpenIntents(db: DbOrTx, chainId: number): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.status, "pending")));
}

export async function listIntentsByOwner(
  db: DbOrTx,
  chainId: number,
  owner: string,
): Promise<Intent[]> {
  return db
    .select()
    .from(intents)
    .where(and(eq(intents.chainId, chainId), eq(intents.owner, owner)));
}
