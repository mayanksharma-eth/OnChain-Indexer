import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./postgres.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** Applies pending migrations to `db`. Safe to call repeatedly (drizzle tracks what's applied). */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
