import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const chains = pgTable(
  "chains",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    name: text("name").notNull(),
    latestBlock: bigint("latest_block", { mode: "number" }).notNull().default(0),
    indexedBlock: bigint("indexed_block", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("chains_chain_id_key").on(table.chainId)],
);

export const blocks = pgTable(
  "blocks",
  {
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }).notNull(),
    isCanonical: boolean("is_canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.blockNumber, table.blockHash] }),
    index("blocks_chain_number_idx").on(table.chainId, table.blockNumber),
    uniqueIndex("blocks_canonical_number_key")
      .on(table.chainId, table.blockNumber)
      .where(sql`${table.isCanonical}`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    transactionIndex: integer("transaction_index").notNull(),
    logIndex: integer("log_index").notNull(),
    contractAddress: text("contract_address").notNull(),
    eventName: text("event_name").notNull(),
    eventSignature: text("event_signature").notNull(),
    decodedData: jsonb("decoded_data").notNull(),
    isCanonical: boolean("is_canonical").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("events_chain_tx_log_key").on(
      table.chainId,
      table.transactionHash,
      table.logIndex,
    ),
    index("events_chain_block_idx").on(table.chainId, table.blockNumber),
    index("events_chain_contract_name_idx").on(
      table.chainId,
      table.contractAddress,
      table.eventName,
    ),
  ],
);

export const intents = pgTable(
  "intents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    intentId: text("intent_id").notNull(),
    owner: text("owner").notNull(),
    tokenIn: text("token_in").notNull(),
    tokenOut: text("token_out").notNull(),
    amountIn: numeric("amount_in", { precision: 78, scale: 0 }).notNull(),
    minAmountOut: numeric("min_amount_out", { precision: 78, scale: 0 }).notNull(),
    deadline: bigint("deadline", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    createdBlock: bigint("created_block", { mode: "number" }).notNull(),
    createdTxHash: text("created_tx_hash").notNull(),
    updatedBlock: bigint("updated_block", { mode: "number" }),
    updatedTxHash: text("updated_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("intents_chain_intent_key").on(table.chainId, table.intentId),
    index("intents_chain_owner_idx").on(table.chainId, table.owner),
    index("intents_chain_status_idx").on(table.chainId, table.status),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id").notNull(),
    intentId: text("intent_id").notNull(),
    solver: text("solver").notNull(),
    amountIn: numeric("amount_in", { precision: 78, scale: 0 }).notNull(),
    amountOut: numeric("amount_out", { precision: 78, scale: 0 }).notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fills_chain_tx_log_key").on(
      table.chainId,
      table.transactionHash,
      table.logIndex,
    ),
    foreignKey({
      columns: [table.chainId, table.intentId],
      foreignColumns: [intents.chainId, intents.intentId],
    }),
    index("fills_chain_intent_idx").on(table.chainId, table.intentId),
    index("fills_chain_solver_idx").on(table.chainId, table.solver),
  ],
);

export const indexerCheckpoints = pgTable(
  "indexer_checkpoints",
  {
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    indexerName: text("indexer_name").notNull(),
    lastProcessedBlock: bigint("last_processed_block", { mode: "number" }).notNull(),
    lastProcessedBlockHash: text("last_processed_block_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.indexerName] })],
);

export type Chain = typeof chains.$inferSelect;
export type NewChain = typeof chains.$inferInsert;
export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Intent = typeof intents.$inferSelect;
export type NewIntent = typeof intents.$inferInsert;
export type Fill = typeof fills.$inferSelect;
export type NewFill = typeof fills.$inferInsert;
export type IndexerCheckpoint = typeof indexerCheckpoints.$inferSelect;
export type NewIndexerCheckpoint = typeof indexerCheckpoints.$inferInsert;
