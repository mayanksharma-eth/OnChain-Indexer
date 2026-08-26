import { createDb } from "./postgres.js";
import { runMigrations } from "./migrations.js";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const db = createDb(connectionString);
  await runMigrations(db);
  await db.$client.end();
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
