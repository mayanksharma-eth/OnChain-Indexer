import type { Database } from "@onchain-indexer/database";
import { createChain, getChainByChainId } from "@onchain-indexer/database";
import type { RpcClient } from "../rpc/client.js";
import { fetchBlockRanges, type FetchBlockRangesOptions } from "../fetcher/fetcher.js";
import { persistFetchedRange, type PersistResult } from "./persist.js";

export interface RunIndexingPipelineOptions extends FetchBlockRangesOptions {
  /** Name to register the chain under if it isn't already known. Default: "chain-{chainId}". */
  chainName?: string;
}

export interface IndexedRangeResult extends PersistResult {
  fromBlock: number;
  toBlock: number;
}

async function ensureChain(db: Database, chainId: number, name: string): Promise<void> {
  const existing = await getChainByChainId(db, chainId);
  if (!existing) await createChain(db, { chainId, name });
}

/**
 * RPC -> block range fetcher -> event decoder -> Postgres, one range at a time.
 * Does not touch intent domain state or checkpoints — persistence only.
 */
export async function* runIndexingPipeline(
  client: RpcClient,
  db: Database,
  chainId: number,
  startBlock: number,
  endBlock: number,
  chunkSize: number,
  options: RunIndexingPipelineOptions = {},
): AsyncGenerator<IndexedRangeResult> {
  await ensureChain(db, chainId, options.chainName ?? `chain-${chainId}`);

  for await (const fetched of fetchBlockRanges(client, startBlock, endBlock, chunkSize, options)) {
    const result = await persistFetchedRange(db, chainId, fetched);
    yield { ...result, fromBlock: fetched.range.fromBlock, toBlock: fetched.range.toBlock };
  }
}
