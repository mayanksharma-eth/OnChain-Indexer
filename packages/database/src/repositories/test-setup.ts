import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll } from "vitest";
import * as schema from "../schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/indexer_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
export const db = drizzle(client, { schema });

let migrated: Promise<unknown> | undefined;

export async function setupTestDb(): Promise<void> {
  migrated ??= migrate(db, { migrationsFolder });
  await migrated;
  await db.execute(
    sql`TRUNCATE TABLE fills, intents, events, blocks, indexer_checkpoints, chains RESTART IDENTITY CASCADE`,
  );
}

afterAll(async () => {
  await client.end();
});
