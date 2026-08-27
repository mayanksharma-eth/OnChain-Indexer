import { z } from "zod";

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string"),
  /** Optional: Redis is a cache-aside layer only, never the source of truth (see
   * packages/database/src/cache.ts). Every read path already degrades to Postgres when this is
   * unset or unreachable, so it isn't required. */
  REDIS_URL: z.string().url("REDIS_URL must be a valid connection string").optional(),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
}
