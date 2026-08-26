CREATE TABLE "blocks" (
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"parent_hash" text NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_chain_id_block_number_block_hash_pk" PRIMARY KEY("chain_id","block_number","block_hash")
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"name" text NOT NULL,
	"latest_block" bigint DEFAULT 0 NOT NULL,
	"indexed_block" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chains_chain_id_key" UNIQUE("chain_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"transaction_index" integer NOT NULL,
	"log_index" integer NOT NULL,
	"contract_address" text NOT NULL,
	"event_name" text NOT NULL,
	"event_signature" text NOT NULL,
	"decoded_data" jsonb NOT NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"intent_id" text NOT NULL,
	"solver" text NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"amount_out" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_checkpoints" (
	"chain_id" integer NOT NULL,
	"indexer_name" text NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"last_processed_block_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_checkpoints_chain_id_indexer_name_pk" PRIMARY KEY("chain_id","indexer_name")
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"intent_id" text NOT NULL,
	"owner" text NOT NULL,
	"token_in" text NOT NULL,
	"token_out" text NOT NULL,
	"amount_in" numeric(78, 0) NOT NULL,
	"min_amount_out" numeric(78, 0) NOT NULL,
	"deadline" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_block" bigint NOT NULL,
	"created_tx_hash" text NOT NULL,
	"updated_block" bigint,
	"updated_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intents_chain_intent_key" UNIQUE("chain_id","intent_id")
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_chain_id_intent_id_intents_chain_id_intent_id_fk" FOREIGN KEY ("chain_id","intent_id") REFERENCES "public"."intents"("chain_id","intent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer_checkpoints" ADD CONSTRAINT "indexer_checkpoints_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_chain_number_idx" ON "blocks" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_canonical_number_key" ON "blocks" USING btree ("chain_id","block_number") WHERE "blocks"."is_canonical";--> statement-breakpoint
CREATE UNIQUE INDEX "events_chain_tx_log_key" ON "events" USING btree ("chain_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "events_chain_block_idx" ON "events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE INDEX "events_chain_contract_name_idx" ON "events" USING btree ("chain_id","contract_address","event_name");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_chain_tx_log_key" ON "fills" USING btree ("chain_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "fills_chain_intent_idx" ON "fills" USING btree ("chain_id","intent_id");--> statement-breakpoint
CREATE INDEX "fills_chain_solver_idx" ON "fills" USING btree ("chain_id","solver");--> statement-breakpoint
CREATE INDEX "intents_chain_owner_idx" ON "intents" USING btree ("chain_id","owner");--> statement-breakpoint
CREATE INDEX "intents_chain_status_idx" ON "intents" USING btree ("chain_id","status");