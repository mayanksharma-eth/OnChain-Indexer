import type { Block, Log } from "viem";
import type { RpcClient } from "../rpc/client.js";
import { withRetry } from "../rpc/retry.js";
import { decodeCowLogs } from "../decoder/cow-decoder.js";
import type { DecodedCowEvent } from "../decoder/cow-events.js";
import { computeBlockRanges, type BlockRange } from "./ranges.js";
import type { FetchBlockRangesOptions } from "./fetcher.js";

export interface FetchedCowBlockRange {
  range: BlockRange;
  /** Blocks referenced by at least one log in this range, ascending by block number. */
  blocks: Block[];
  /** Decoded CoW events, ordered by (blockNumber, logIndex) for deterministic downstream processing. */
  events: DecodedCowEvent[];
}

function sortLogs(logs: readonly Log[]): Log[] {
  return [...logs].sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n;
    const bBlock = b.blockNumber ?? 0n;
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

async function fetchOneCowRange(client: RpcClient, range: BlockRange): Promise<FetchedCowBlockRange> {
  const logs = sortLogs(await client.getLogs(range.fromBlock, range.toBlock));

  const logBlockNumbers = logs.map((log) => log.blockNumber).filter((n): n is bigint => n !== null);
  const blockNumbers = [...new Set([...logBlockNumbers, BigInt(range.toBlock)])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const blocks = await Promise.all(blockNumbers.map((n) => client.getBlock(n)));

  return { range, blocks, events: decodeCowLogs(logs) };
}

/**
 * CoW-protocol counterpart to fetcher.ts's `fetchBlockRanges` — same chunking/retry contract,
 * decoding against the CoW ABI instead of the intent ABI. See fetcher.ts for the full behavior
 * contract (strict order, per-range retry, includes the range's toBlock even with no logs).
 */
export async function* fetchCowBlockRanges(
  client: RpcClient,
  startBlock: number,
  endBlock: number,
  chunkSize: number,
  options: FetchBlockRangesOptions = {},
): AsyncGenerator<FetchedCowBlockRange> {
  const { maxRetries = 2, baseDelayMs = 200 } = options;

  for (const range of computeBlockRanges(startBlock, endBlock, chunkSize)) {
    yield await withRetry(() => fetchOneCowRange(client, range), {
      method: `fetchCowBlockRange(${range.fromBlock}-${range.toBlock})`,
      maxRetries,
      baseDelayMs,
    });
  }
}
