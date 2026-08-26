import { afterAll } from "vitest";
import { createDb, runMigrations, type Database } from "@onchain-indexer/database";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/indexer_test";

export const db: Database = createDb(DATABASE_URL);

let migrated: Promise<void> | undefined;

/** Applies migrations once per test run. Tests use a fresh random chainId each, so no
 * truncation is needed for isolation between tests or across runs. */
export async function setupTestDb(): Promise<void> {
  migrated ??= runMigrations(db);
  await migrated;
}

export function randomChainId(): number {
  return 900_000 + Math.floor(Math.random() * 90_000);
}

afterAll(async () => {
  await db.$client.end();
});
