import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { IntentStatus } from "@onchain-indexer/database";

/** Validates a hex address and normalizes it to EIP-55 checksum case — the same casing the
 * indexer stores (see apps/indexer/src/decoder/decoder.ts), so filter comparisons match. */
export const addressSchema = z
  .string()
  .trim()
  .refine((value): value is `0x${string}` => isAddress(value), "invalid address")
  .transform((value) => getAddress(value));

export const intentIdSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "invalid intentId: expected a 0x-prefixed 32-byte hex string");

export const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, "invalid transaction hash: expected a 0x-prefixed 32-byte hex string")
  .transform((value) => value.toLowerCase());

/** CoW Protocol order UID: 56 packed bytes (orderDigest[32] || owner[20] || validTo[4]), per
 * GPv2Order.packOrderUidParams — see packages/abi/src/cow.ts. */
export const orderUidSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{112}$/, "invalid orderUid: expected a 0x-prefixed 56-byte hex string")
  .transform((value) => value.toLowerCase());

export const blockNumberSchema = z.coerce.number().int().nonnegative();

export const intentStatusSchema = z.enum([
  IntentStatus.OPEN,
  IntentStatus.CANCELLED,
  IntentStatus.FILLED,
]);

const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

export const limitSchema = z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT);

/** Cursor is the last-seen row id from the previous page (see listIntents' `id`-based
 * pagination) — a positive integer, not an opaque token. */
export const cursorSchema = z.coerce.number().int().positive().optional();
