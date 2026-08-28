CREATE TABLE "cow_order_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"owner" text NOT NULL,
	"order_uid" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cow_settlements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"solver" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"transaction_hash" text NOT NULL,
	"transaction_index" integer NOT NULL,
	"log_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cow_settlements_chain_tx_key" UNIQUE("chain_id","transaction_hash")
);
--> statement-breakpoint
CREATE TABLE "cow_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"owner" text NOT NULL,
	"sell_token" text NOT NULL,
	"buy_token" text NOT NULL,
	"sell_amount" numeric(78, 0) NOT NULL,
	"buy_amount" numeric(78, 0) NOT NULL,
	"fee_amount" numeric(78, 0) NOT NULL,
	"order_uid" text NOT NULL,
	"block_number" bigint NOT NULL,
	"transaction_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cow_order_events" ADD CONSTRAINT "cow_order_events_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cow_settlements" ADD CONSTRAINT "cow_settlements_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cow_trades" ADD CONSTRAINT "cow_trades_chain_id_chains_chain_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("chain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cow_trades" ADD CONSTRAINT "cow_trades_chain_id_transaction_hash_cow_settlements_chain_id_transaction_hash_fk" FOREIGN KEY ("chain_id","transaction_hash") REFERENCES "public"."cow_settlements"("chain_id","transaction_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cow_order_events_chain_tx_log_key" ON "cow_order_events" USING btree ("chain_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "cow_order_events_chain_order_uid_idx" ON "cow_order_events" USING btree ("chain_id","order_uid","id");--> statement-breakpoint
CREATE INDEX "cow_order_events_chain_owner_idx" ON "cow_order_events" USING btree ("chain_id","owner","id");--> statement-breakpoint
CREATE INDEX "cow_settlements_chain_solver_idx" ON "cow_settlements" USING btree ("chain_id","solver","id");--> statement-breakpoint
CREATE INDEX "cow_settlements_chain_block_idx" ON "cow_settlements" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cow_trades_chain_tx_log_key" ON "cow_trades" USING btree ("chain_id","transaction_hash","log_index");--> statement-breakpoint
CREATE INDEX "cow_trades_chain_owner_idx" ON "cow_trades" USING btree ("chain_id","owner","id");--> statement-breakpoint
CREATE INDEX "cow_trades_chain_order_uid_idx" ON "cow_trades" USING btree ("chain_id","order_uid","id");--> statement-breakpoint
CREATE INDEX "cow_trades_chain_tx_idx" ON "cow_trades" USING btree ("chain_id","transaction_hash");--> statement-breakpoint
CREATE INDEX "cow_trades_chain_block_idx" ON "cow_trades" USING btree ("chain_id","block_number");