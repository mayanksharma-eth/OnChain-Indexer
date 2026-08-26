DROP INDEX "fills_chain_intent_idx";--> statement-breakpoint
DROP INDEX "intents_chain_owner_idx";--> statement-breakpoint
DROP INDEX "intents_chain_status_idx";--> statement-breakpoint
CREATE INDEX "intents_chain_token_pair_idx" ON "intents" USING btree ("chain_id","token_in","token_out","id");--> statement-breakpoint
CREATE INDEX "fills_chain_intent_idx" ON "fills" USING btree ("chain_id","intent_id","id");--> statement-breakpoint
CREATE INDEX "intents_chain_owner_idx" ON "intents" USING btree ("chain_id","owner","id");--> statement-breakpoint
CREATE INDEX "intents_chain_status_idx" ON "intents" USING btree ("chain_id","status","id");