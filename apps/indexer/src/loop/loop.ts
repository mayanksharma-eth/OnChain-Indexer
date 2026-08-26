import { createRedis, getCheckpoint, invalidateChainCache, type Database } from "@onchain-indexer/database";
import { logger } from "@onchain-indexer/utils";
import type { RpcClient } from "../rpc/client.js";
import { runIndexingPipeline } from "../pipeline/index.js";
import { loadStartBlock } from "../checkpoint/index.js";
import { handleReorg, ReorgTooDeepError } from "../reorg/index.js";
import { indexerStatus, type IndexerStatusService } from "../status/index.js";

export interface IndexerLoopOptions {
  client: RpcClient;
  db: Database;
  chainId: number;
  indexerName: string;
  /** Used to invalidate the API's response cache after each successfully persisted range. Null
   * (no Redis configured) just skips invalidation — the API's cache TTL still bounds staleness. */
  redis?: ReturnType<typeof createRedis> | null;
  /** Block to start from if this (chainId, indexerName) has never checkpointed before. */
  startBlock: number;
  chunkSize: number;
  confirmations: number;
  pollIntervalMs: number;
  /** Aborted to stop the loop (e.g. on SIGINT/SIGTERM) — checked before each cycle and each sleep. */
  signal: AbortSignal;
  /** Injectable for tests; defaults to a real, abort-interruptible setTimeout sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable for tests; defaults to the process-wide singleton (see status/index.ts). */
  status?: IndexerStatusService;
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
  const redis = options.redis ?? null;
  const sleep = options.sleep ?? defaultSleep;
  const status = options.status ?? indexerStatus;
  const identity = { chainId, indexerName };

  status.start(chainId);

  while (!signal.aborted) {
    const cycleStart = Date.now();
    try {
      let checkpoint = await getCheckpoint(db, chainId, indexerName);
      if (checkpoint) {
        // Before accepting new blocks: verify the previously indexed canonical block still
        // matches what the chain reports at that height. A mismatch means everything above it
        // was reorged out from under us.
        const onChainBlock = await client.getBlock(checkpoint.lastProcessedBlock);
        if (onChainBlock.hash !== checkpoint.lastProcessedBlockHash) {
          status.setState("REORGING");
          await handleReorg(db, client, chainId, indexerName, checkpoint.lastProcessedBlock);
          checkpoint = await getCheckpoint(db, chainId, indexerName);
        }
      }
      const startBlock = await loadStartBlock(db, identity, options.startBlock);

      const latest = await client.getLatestBlock();
      if (latest.number === null) throw new Error("latest block has no number (pending block?)");
      const latestBlock = Number(latest.number);
      const safeBlock = latestBlock - confirmations;

      status.setState(
        startBlock > safeBlock ? "CAUGHT_UP" : safeBlock - startBlock > chunkSize ? "BACKFILLING" : "SYNCING",
      );

      let eventsProcessed = 0;
      let indexedBlock = checkpoint?.lastProcessedBlock ?? startBlock - 1;
      if (startBlock <= safeBlock) {
        let chunkStart = Date.now();
        for await (const result of runIndexingPipeline(client, db, chainId, startBlock, safeBlock, chunkSize, {
          indexerName,
        })) {
          eventsProcessed += result.eventsProcessed;
          indexedBlock = result.toBlock;
          await invalidateChainCache(redis, chainId);
          logger.info("indexing operation complete", {
            chainId,
            fromBlock: result.fromBlock,
            toBlock: result.toBlock,
            eventsFound: result.eventsProcessed,
            eventsInserted: result.eventsProcessed,
            duration: Date.now() - chunkStart,
          });
          status.recordIndexed({ events: result.eventsProcessed, intents: result.intentsIndexed, fills: result.fillsIndexed });
          chunkStart = Date.now();
          if (signal.aborted) break;
        }
      }

      status.recordProgress({ chainHead: latestBlock, safeBlock, indexedBlock });
      status.setState(indexedBlock >= safeBlock ? "CAUGHT_UP" : "SYNCING");

      logger.info("poll cycle complete", {
        checkpoint: checkpoint?.lastProcessedBlock ?? null,
        latestBlock,
        safeBlock,
        blockLag: latestBlock - startBlock,
        eventsProcessed,
        durationMs: Date.now() - cycleStart,
      });
    } catch (error) {
      status.recordError(error);
      if (error instanceof ReorgTooDeepError) {
        status.setState("ERROR");
        logger.error("REORG EXCEEDS MAX_REORG_DEPTH — entering ERROR state, indexing stopped", {
          chainId,
          indexerName,
          error: String(error),
        });
        throw error;
      }
      logger.error("poll cycle failed, will retry next poll interval", {
        error: String(error),
        durationMs: Date.now() - cycleStart,
      });
    }

    if (signal.aborted) break;
    await sleep(pollIntervalMs, signal);
  }

  status.setState("STOPPED");
  logger.info("indexer loop stopped");
}
