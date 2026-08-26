import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@onchain-indexer/database";
import { ok, type AppState, type RedisClient } from "../lib/http.js";

const CHECK_TIMEOUT_MS = 2000;

async function checkWithTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("check timed out")), ms);
  });
  try {
    await Promise.race([promise, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const readyChecksSchema = z.object({
  database: z.boolean(),
  redis: z.boolean().nullable(),
  initialized: z.boolean(),
});

export interface HealthRouteDeps {
  db: Database;
  redis: RedisClient | null;
  state: AppState;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get("/health", () => ok({ status: "ok" as const }));

  app.get("/ready", async (_request, reply) => {
    const [database, redis] = await Promise.all([
      checkWithTimeout(deps.db.execute(sql`select 1`), CHECK_TIMEOUT_MS),
      deps.redis ? checkWithTimeout(deps.redis.ping(), CHECK_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    const checks = readyChecksSchema.parse({ database, redis, initialized: deps.state.initialized });
    const isReady = checks.database && checks.redis !== false && checks.initialized;

    reply.code(isReady ? 200 : 503).send(ok({ status: isReady ? "ready" : "not_ready", checks }));
  });
}
