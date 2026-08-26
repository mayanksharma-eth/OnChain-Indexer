import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client);
}

export type Database = ReturnType<typeof createDb>;
