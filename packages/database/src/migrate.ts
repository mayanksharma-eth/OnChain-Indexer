import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder });
  await client.end();
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
