import { z } from "zod";
import { baseEnvSchema, formatZodError } from "./env.js";

export const apiConfigSchema = baseEnvSchema.extend({
  API_PORT: z.coerce
    .number()
    .int()
    .min(1, "API_PORT must be between 1 and 65535")
    .max(65535, "API_PORT must be between 1 and 65535")
    .default(3000),
  /** Which chain's data this API instance serves — mirrors the indexer's CHAIN_ID, since the
   * schema is multi-chain but a solver-facing endpoint takes no chainId filter. */
  CHAIN_ID: z.coerce.number().int().positive("CHAIN_ID must be a positive integer").default(31337),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = apiConfigSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid API configuration:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}
