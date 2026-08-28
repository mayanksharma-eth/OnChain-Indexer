import type { Database } from "@onchain-indexer/database";
import { createChain, getChainByChainId } from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { fetchCowBlockRanges } from "../fetcher/cow-fetcher.js";
import type { FetchBlockRangesOptions } from "../fetcher/fetcher.js";
import { persistFetchedCowRange, type CowPersistResult } from "./cow-persist.js";

export interface RunCowIndexingPipelineOptions extends FetchBlockRangesOptions {
  chainName?: string;
  indexerName?: string;
}

export interface IndexedCowRangeResult extends CowPersistResult {
  fromBlock: number;
  toBlock: number;
}

async function ensureChain(db: Database, chainId: number, name: string): Promise<void> {
  const existing = await getChainByChainId(db, chainId);
  if (!existing) await createChain(db, { chainId, name });
}

/**
 * CoW-protocol counterpart to pipeline/pipeline.ts's `runIndexingPipeline` — RPC -> block range
 * fetcher -> CoW ABI decoder -> Postgres, one range at a time. Default `indexerName` is
 * "cow-events" so this checkpoints independently from the intent protocol's "events" stream even
 * when both point at the same chainId (see apps/indexer/src/index-cow.ts).
 */
export async function* runCowIndexingPipeline(
  client: RpcClient,
  db: Database,
  chainId: number,
  startBlock: number,
  endBlock: number,
  chunkSize: number,
  options: RunCowIndexingPipelineOptions = {},
): AsyncGenerator<IndexedCowRangeResult> {
  await ensureChain(db, chainId, options.chainName ?? `chain-${chainId}`);
  const indexerName = options.indexerName ?? "cow-events";

  for await (const fetched of fetchCowBlockRanges(client, startBlock, endBlock, chunkSize, options)) {
    const result = await persistFetchedCowRange(db, chainId, indexerName, fetched);
    yield { ...result, fromBlock: fetched.range.fromBlock, toBlock: fetched.range.toBlock };
  }
}
