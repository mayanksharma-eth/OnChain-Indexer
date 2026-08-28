import { createRedis, getCheckpoint, invalidateCowCache, updateChainProgress, type Database } from "@onchain-indexer/database";
import {
  indexerBlockLag,
  indexerBlocksProcessedTotal,
  indexerEventsProcessedTotal,
  indexerProcessingDuration,
  logger,
} from "@onchain-indexer/utils";
import type { RpcClient } from "../rpc/client.js";
import { runCowIndexingPipeline } from "../pipeline/cow-pipeline.js";
import { loadStartBlock } from "../checkpoint/index.js";
import { handleReorg, ReorgTooDeepError } from "../reorg/index.js";
import { rollbackCowProjectionsFromBlock } from "../projection/cow-rollback.js";
import { indexerStatus, type IndexerStatusService } from "../status/index.js";

export interface CowIndexerLoopOptions {
  client: RpcClient;
  db: Database;
  chainId: number;
  indexerName: string;
  redis?: ReturnType<typeof createRedis> | null;
  startBlock: number;
  chunkSize: number;
  confirmations: number;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
 * CoW-protocol counterpart to loop/loop.ts's `runIndexerLoop` — identical poll/backfill/reorg
 * contract, wired to the CoW pipeline and CoW rollback instead of the intent ones. See loop.ts
 * for the full behavior contract (never past `latestBlock - confirmations`, checkpoint only
 * advances transactionally, reorg detected by re-checking the checkpointed block's hash each
 * cycle).
 *
 * ponytail: status.recordIndexed's `intents`/`fills` fields are intent-protocol-specific and
 * don't apply here, so this passes zeros and logs the real settlement/trade counts directly
 * instead of extending the shared in-process status snapshot for a second protocol's vocabulary.
 */
export async function runCowIndexerLoop(options: CowIndexerLoopOptions): Promise<void> {
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
        const onChainBlock = await client.getBlock(checkpoint.lastProcessedBlock);
        if (onChainBlock.hash !== checkpoint.lastProcessedBlockHash) {
          status.setState("REORGING");
          await handleReorg(db, client, chainId, indexerName, checkpoint.lastProcessedBlock, rollbackCowProjectionsFromBlock);
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
        for await (const result of runCowIndexingPipeline(client, db, chainId, startBlock, safeBlock, chunkSize, {
          indexerName,
        })) {
          eventsProcessed += result.eventsProcessed;
          indexedBlock = result.toBlock;
          await invalidateCowCache(redis, chainId);
          const durationMs = Date.now() - chunkStart;
          logger.info("cow indexing operation complete", {
            chainId,
            fromBlock: result.fromBlock,
            toBlock: result.toBlock,
            eventsProcessed: result.eventsProcessed,
            settlementsIndexed: result.settlementsIndexed,
            tradesIndexed: result.tradesIndexed,
            orderEventsIndexed: result.orderEventsIndexed,
            duration: durationMs,
          });
          indexerBlocksProcessedTotal.inc({ chain_id: chainId }, result.blocksProcessed);
          indexerEventsProcessedTotal.inc({ chain_id: chainId }, result.eventsProcessed);
          indexerProcessingDuration.observe({ chain_id: chainId }, durationMs / 1000);
          status.recordIndexed({ events: result.eventsProcessed, intents: 0, fills: 0 });
          chunkStart = Date.now();
          if (signal.aborted) break;
        }
      }

      indexerBlockLag.set({ chain_id: chainId }, latestBlock - indexedBlock);
      status.recordProgress({ chainHead: latestBlock, safeBlock, indexedBlock });
      status.setState(indexedBlock >= safeBlock ? "CAUGHT_UP" : "SYNCING");
      await updateChainProgress(db, chainId, { latestBlock, indexedBlock });

      logger.info("cow poll cycle complete", {
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
        logger.error("REORG EXCEEDS MAX_REORG_DEPTH — entering ERROR state, cow indexing stopped", {
          chainId,
          indexerName,
          error: String(error),
        });
        throw error;
      }
      logger.error("cow poll cycle failed, will retry next poll interval", {
        error: String(error),
        durationMs: Date.now() - cycleStart,
      });
    }

    if (signal.aborted) break;
    await sleep(pollIntervalMs, signal);
  }

  status.setState("STOPPED");
  logger.info("cow indexer loop stopped");
}
