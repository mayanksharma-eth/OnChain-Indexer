import type { createRedis } from "@onchain-indexer/database";

export type RedisClient = ReturnType<typeof createRedis>;

/** Thrown by route handlers to produce a specific status/code via the centralized error handler. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, message: string, code = "app_error") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/** Envelope for solver-facing responses: every one reports the indexed block (from
 * indexer_checkpoints) it was constructed from, so solvers know how fresh the data is. */
export function okAtBlock<T>(
  data: T,
  indexedBlock: number | null,
): { success: true; data: T; indexedBlock: number | null } {
  return { success: true, data, indexedBlock };
}

export function okListAtBlock<T>(
  data: T[],
  indexedBlock: number | null,
  nextCursor: string | null,
): { success: true; data: T[]; indexedBlock: number | null; nextCursor: string | null } {
  return { success: true, data, indexedBlock, nextCursor };
}

/** The intent-protocol indexing stream (see apps/indexer/src/index.ts) — checkpoints are keyed
 * by (chainId, indexerName), so the API needs the same name to read them back. */
export const INDEXER_NAME = "events";

/** The CoW-adapter indexing stream (see apps/indexer/src/index-cow.ts) — a separate checkpoint
 * from INDEXER_NAME so the two protocols can run against the same chainId independently. */
export const COW_INDEXER_NAME = "cow-events";

/** Flips to true once app bootstrap (plugin/route registration) has finished — read by GET /ready. */
export interface AppState {
  initialized: boolean;
}
