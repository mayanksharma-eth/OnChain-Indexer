export interface BlockRange {
  fromBlock: number;
  toBlock: number;
}

/**
 * Splits [startBlock, endBlock] into sequential, non-overlapping, gap-free ranges of at
 * most chunkSize blocks each. The final range is truncated to endBlock if it doesn't
 * divide evenly.
 */
export function computeBlockRanges(startBlock: number, endBlock: number, chunkSize: number): BlockRange[] {
  if (!Number.isInteger(startBlock) || !Number.isInteger(endBlock) || !Number.isInteger(chunkSize)) {
    throw new RangeError("startBlock, endBlock, and chunkSize must be integers");
  }
  if (startBlock < 0 || endBlock < 0) {
    throw new RangeError("startBlock and endBlock must be non-negative");
  }
  if (chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  if (startBlock > endBlock) {
    throw new RangeError(`startBlock (${startBlock}) must be <= endBlock (${endBlock})`);
  }

  const ranges: BlockRange[] = [];
  for (let from = startBlock; from <= endBlock; from += chunkSize) {
    ranges.push({ fromBlock: from, toBlock: Math.min(from + chunkSize - 1, endBlock) });
  }
  return ranges;
}
