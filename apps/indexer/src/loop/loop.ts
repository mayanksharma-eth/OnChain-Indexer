import { getCheckpoint, type Database } from "@onchain-indexer/database";
import { logger } from "@onchain-indexer/utils";
import type { RpcClient } from "../rpc/client.js";
import { runIndexingPipeline } from "../pipeline/index.js";
import { loadStartBlock } from "../checkpoint/index.js";

export interface IndexerLoopOptions {
  client: RpcClient;
  db: Database;
  chainId: number;
  indexerName: string;
  /** Block to start from if this (chainId, indexerName) has never checkpointed before. */
  startBlock: number;
  chunkSize: number;
  confirmations: number;
  pollIntervalMs: number;
  /** Aborted to stop the loop (e.g. on SIGINT/SIGTERM) — checked before each cycle and each sleep. */
  signal: AbortSignal;
  /** Injectable for tests; defaults to a real, abort-interruptible setTimeout sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Poll-forever loop: load checkpoint -> fetch latest chain block -> compute the safe
 * (confirmed) block -> index up to it -> sleep -> repeat.
 *
 * Never processes past latestBlock - confirmations. The checkpoint only ever advances
 * transactionally per block range inside runIndexingPipeline (see pipeline/persist.ts), so a
 * cycle that throws (RPC blip, DB error, etc.) just gets logged and retried next poll with
 * whatever the last committed checkpoint was — nothing partial is ever recorded as done.
 */
export async function runIndexerLoop(options: IndexerLoopOptions): Promise<void> {
  const { client, db, chainId, indexerName, chunkSize, confirmations, pollIntervalMs, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const identity = { chainId, indexerName };

  while (!signal.aborted) {
    const cycleStart = Date.now();
    try {
      const checkpoint = await getCheckpoint(db, chainId, indexerName);
      const startBlock = await loadStartBlock(db, identity, options.startBlock);

      const latest = await client.getLatestBlock();
      if (latest.number === null) throw new Error("latest block has no number (pending block?)");
      const latestBlock = Number(latest.number);
      const safeBlock = latestBlock - confirmations;

      let eventsProcessed = 0;
      if (startBlock <= safeBlock) {
        for await (const result of runIndexingPipeline(client, db, chainId, startBlock, safeBlock, chunkSize, {
          indexerName,
        })) {
          eventsProcessed += result.eventsProcessed;
          if (signal.aborted) break;
        }
      }

      logger.info("poll cycle complete", {
        checkpoint: checkpoint?.lastProcessedBlock ?? null,
        latestBlock,
        safeBlock,
        blockLag: latestBlock - startBlock,
        eventsProcessed,
        durationMs: Date.now() - cycleStart,
      });
    } catch (error) {
      logger.error("poll cycle failed, will retry next poll interval", {
        error: String(error),
        durationMs: Date.now() - cycleStart,
      });
    }

    if (signal.aborted) break;
    await sleep(pollIntervalMs, signal);
  }

  logger.info("indexer loop stopped");
}
