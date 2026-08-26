import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/** Accepts either the top-level `Database` or an active `db.transaction()` handle, so repository
 * functions can be composed atomically by the caller (e.g. reorg handling across repositories). */
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
