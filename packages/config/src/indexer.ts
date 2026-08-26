import { z } from "zod";
import { baseEnvSchema, formatZodError } from "./env.js";

export const indexerConfigSchema = baseEnvSchema.extend({
  RPC_URL: z.string().url("RPC_URL must be a valid URL"),
  CHAIN_ID: z.coerce.number().int().positive("CHAIN_ID must be a positive integer").default(31337),
  INDEXER_START_BLOCK: z.coerce
    .number()
    .int()
    .nonnegative("INDEXER_START_BLOCK must be a non-negative integer")
    .default(0),
  INDEXER_CHUNK_SIZE: z.coerce
    .number()
    .int()
    .positive("INDEXER_CHUNK_SIZE must be a positive integer")
    .default(2000),
  INDEXER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive("INDEXER_POLL_INTERVAL_MS must be a positive integer")
    .default(4000),
  CONFIRMATIONS: z.coerce
    .number()
    .int()
    .nonnegative("CONFIRMATIONS must be a non-negative integer")
    .default(5),
});

export type IndexerConfig = z.infer<typeof indexerConfigSchema>;

export function loadIndexerConfig(source: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const parsed = indexerConfigSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid indexer configuration:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}
