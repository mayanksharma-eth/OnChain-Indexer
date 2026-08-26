import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listIntents, type Database } from "@onchain-indexer/database";
import { okListAtBlock } from "../lib/http.js";
import { getIndexedBlock } from "../lib/indexed-block.js";
import { addressSchema, cursorSchema, intentStatusSchema, limitSchema } from "../lib/validation.js";

const addressParamSchema = z.object({ address: addressSchema });

const listAddressIntentsQuerySchema = z.object({
  status: intentStatusSchema.optional(),
  tokenIn: addressSchema.optional(),
  tokenOut: addressSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export interface AddressRouteDeps {
  db: Database;
  chainId: number;
}

export function registerAddressRoutes(app: FastifyInstance, deps: AddressRouteDeps): void {
  const { db, chainId } = deps;

  app.get("/addresses/:address/intents", async (request) => {
    const { address } = addressParamSchema.parse(request.params);
    const query = listAddressIntentsQuerySchema.parse(request.query);

    const indexedBlock = await getIndexedBlock(db, chainId);
    const rows = await listIntents(db, chainId, { ...query, owner: address });
    const nextCursor = rows.length === query.limit ? String(rows[rows.length - 1]!.id) : null;

    return okListAtBlock(rows, indexedBlock, nextCursor);
  });
}
