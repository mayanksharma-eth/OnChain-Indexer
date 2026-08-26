import type { Block, Log } from "viem";
import type { RpcClient } from "../rpc/client.js";
import { withRetry } from "../rpc/retry.js";
import { decodeIntentLogs } from "../decoder/decoder.js";
import type { DecodedIntentEvent } from "../decoder/events.js";
import { computeBlockRanges, type BlockRange } from "./ranges.js";

export interface FetchedBlockRange {
  range: BlockRange;
  /** Blocks referenced by at least one log in this range, ascending by block number. */
  blocks: Block[];
  /** Decoded intent events, ordered by (blockNumber, logIndex) for deterministic downstream processing. */
  events: DecodedIntentEvent[];
}

export interface FetchBlockRangesOptions {
  /** Retries per range (on top of the RPC client's own per-call retries) before giving up. Default: 2. */
  maxRetries?: number;
  /** Base delay for range-retry exponential backoff, in ms. Default: 200. */
  baseDelayMs?: number;
}

function sortLogs(logs: readonly Log[]): Log[] {
  return [...logs].sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n;
    const bBlock = b.blockNumber ?? 0n;
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

async function fetchOneRange(client: RpcClient, range: BlockRange): Promise<FetchedBlockRange> {
  const logs = sortLogs(await client.getLogs(range.fromBlock, range.toBlock));

  // Always include the range's own toBlock, even if no logs landed in it — checkpointing
  // needs that block's hash to record how far this range advanced.
  const logBlockNumbers = logs.map((log) => log.blockNumber).filter((n): n is bigint => n !== null);
  const blockNumbers = [...new Set([...logBlockNumbers, BigInt(range.toBlock)])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const blocks = await Promise.all(blockNumbers.map((n) => client.getBlock(n)));

  return { range, blocks, events: decodeIntentLogs(logs) };
}

/**
 * Fetches logs + the block metadata they reference across [startBlock, endBlock] in
 * chunkSize-sized ranges, yielding one normalized result per range in strict order.
 * Each range is retried as a unit; a range that still fails after retries throws and
 * stops iteration there (nothing later is skipped or fetched out of order).
 */
export async function* fetchBlockRanges(
  client: RpcClient,
  startBlock: number,
  endBlock: number,
  chunkSize: number,
  options: FetchBlockRangesOptions = {},
): AsyncGenerator<FetchedBlockRange> {
  const { maxRetries = 2, baseDelayMs = 200 } = options;

  for (const range of computeBlockRanges(startBlock, endBlock, chunkSize)) {
    yield await withRetry(() => fetchOneRange(client, range), {
      method: `fetchBlockRange(${range.fromBlock}-${range.toBlock})`,
      maxRetries,
      baseDelayMs,
    });
  }
}
