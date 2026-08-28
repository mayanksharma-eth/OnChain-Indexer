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

/** Lifecycle states for an intent's domain status. See apps/indexer/src/projection for the
 * transition rules that assign these. */
export const IntentStatus = {
  OPEN: "OPEN",
  CANCELLED: "CANCELLED",
  FILLED: "FILLED",
} as const;
export type IntentStatusValue = (typeof IntentStatus)[keyof typeof IntentStatus];

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
    status: text("status").notNull().default(IntentStatus.OPEN),
    createdBlock: bigint("created_block", { mode: "number" }).notNull(),
    createdTxHash: text("created_tx_hash").notNull(),
    updatedBlock: bigint("updated_block", { mode: "number" }),
    updatedTxHash: text("updated_tx_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("intents_chain_intent_key").on(table.chainId, table.intentId),
    // `id` trails each filter column so listIntents' cursor pagination (WHERE ... AND id > cursor
    // ORDER BY id LIMIT n) is satisfied entirely by the index — no separate sort, no scanning past
    // non-matching rows to find the next page.
    index("intents_chain_owner_idx").on(table.chainId, table.owner, table.id),
    index("intents_chain_status_idx").on(table.chainId, table.status, table.id),
    index("intents_chain_token_pair_idx").on(table.chainId, table.tokenIn, table.tokenOut, table.id),
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
    // `id` trails so listFillsByIntent's ORDER BY id is satisfied by the index directly.
    index("fills_chain_intent_idx").on(table.chainId, table.intentId, table.id),
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

/**
 * CoW Protocol adapter tables — onchain settlement execution state derived from GPv2Settlement's
 * Trade/Settlement/OrderInvalidated events (see packages/abi/src/cow.ts). These represent what
 * can honestly be derived from indexed onchain events: which solver executed which settlement
 * transaction, which orders were matched in it, and which orders were invalidated onchain. This
 * is NOT a reconstruction of the offchain CoW orderbook (order creation/quoting happens offchain
 * and is never emitted onchain) — only the settlement layer that actually lands onchain.
 */

/** One row per Settlement event — one per `settle()` call. `transactionHash` is unique per chain
 * because a transaction calls `settle()` at most once; this is also the FK target `cowTrades`
 * uses to associate trades with the settlement transaction that executed them. */
export const cowSettlements = pgTable(
  "cow_settlements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    solver: text("solver").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockHash: text("block_hash").notNull(),
    transactionHash: text("transaction_hash").notNull(),
    transactionIndex: integer("transaction_index").notNull(),
    logIndex: integer("log_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("cow_settlements_chain_tx_key").on(table.chainId, table.transactionHash),
    index("cow_settlements_chain_solver_idx").on(table.chainId, table.solver, table.id),
    index("cow_settlements_chain_block_idx").on(table.chainId, table.blockNumber),
  ],
);

/** One row per Trade event — one per order matched in a settlement's batch. A single `orderUid`
 * can appear in more than one row (CoW Protocol supports partial fills across separate
 * settlements), so this is an execution history per order, not a 1:1 order record. */
export const cowTrades = pgTable(
  "cow_trades",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    owner: text("owner").notNull(),
    sellToken: text("sell_token").notNull(),
    buyToken: text("buy_token").notNull(),
    sellAmount: numeric("sell_amount", { precision: 78, scale: 0 }).notNull(),
    buyAmount: numeric("buy_amount", { precision: 78, scale: 0 }).notNull(),
    feeAmount: numeric("fee_amount", { precision: 78, scale: 0 }).notNull(),
    /** 56-byte packed orderUid (orderDigest[32] || owner[20] || validTo[4]) as 0x-hex, per
     * GPv2Order.packOrderUidParams. */
    orderUid: text("order_uid").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cow_trades_chain_tx_log_key").on(table.chainId, table.transactionHash, table.logIndex),
    foreignKey({
      columns: [table.chainId, table.transactionHash],
      foreignColumns: [cowSettlements.chainId, cowSettlements.transactionHash],
    }),
    index("cow_trades_chain_owner_idx").on(table.chainId, table.owner, table.id),
    index("cow_trades_chain_order_uid_idx").on(table.chainId, table.orderUid, table.id),
    index("cow_trades_chain_tx_idx").on(table.chainId, table.transactionHash),
    index("cow_trades_chain_block_idx").on(table.chainId, table.blockNumber),
  ],
);

/** One row per OrderInvalidated event — an order the owner cancelled onchain. Unrelated to any
 * settlement transaction (emitted by a separate `invalidateOrder()` call), so no FK to
 * `cowSettlements`. */
export const cowOrderEvents = pgTable(
  "cow_order_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.chainId),
    owner: text("owner").notNull(),
    orderUid: text("order_uid").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    transactionHash: text("transaction_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cow_order_events_chain_tx_log_key").on(table.chainId, table.transactionHash, table.logIndex),
    index("cow_order_events_chain_order_uid_idx").on(table.chainId, table.orderUid, table.id),
    index("cow_order_events_chain_owner_idx").on(table.chainId, table.owner, table.id),
  ],
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
export type CowSettlement = typeof cowSettlements.$inferSelect;
export type NewCowSettlement = typeof cowSettlements.$inferInsert;
export type CowTrade = typeof cowTrades.$inferSelect;
export type NewCowTrade = typeof cowTrades.$inferInsert;
export type CowOrderEvent = typeof cowOrderEvents.$inferSelect;
export type NewCowOrderEvent = typeof cowOrderEvents.$inferInsert;
