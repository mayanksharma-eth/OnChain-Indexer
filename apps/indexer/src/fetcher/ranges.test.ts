import { describe, expect, it } from "vitest";
import { computeBlockRanges } from "./ranges.js";

describe("computeBlockRanges", () => {
  it("splits an exact multiple of chunkSize into equal chunks", () => {
    expect(computeBlockRanges(1000, 2499, 500)).toEqual([
      { fromBlock: 1000, toBlock: 1499 },
      { fromBlock: 1500, toBlock: 1999 },
      { fromBlock: 2000, toBlock: 2499 },
    ]);
  });

  it("truncates the final chunk when the range doesn't divide evenly", () => {
    expect(computeBlockRanges(0, 1049, 500)).toEqual([
      { fromBlock: 0, toBlock: 499 },
      { fromBlock: 500, toBlock: 999 },
      { fromBlock: 1000, toBlock: 1049 },
    ]);
  });

  it("produces a single one-block range when start equals end", () => {
    expect(computeBlockRanges(42, 42, 500)).toEqual([{ fromBlock: 42, toBlock: 42 }]);
  });

  it("never skips or overlaps blocks across chunk boundaries", () => {
    const ranges = computeBlockRanges(0, 9999, 777);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.fromBlock).toBe(ranges[i - 1]!.toBlock + 1);
    }
    expect(ranges[0]!.fromBlock).toBe(0);
    expect(ranges.at(-1)?.toBlock).toBe(9999);
  });

  it("rejects startBlock greater than endBlock", () => {
    expect(() => computeBlockRanges(100, 50, 10)).toThrow(RangeError);
  });

  it("rejects a non-positive chunkSize", () => {
    expect(() => computeBlockRanges(0, 100, 0)).toThrow(RangeError);
    expect(() => computeBlockRanges(0, 100, -5)).toThrow(RangeError);
  });

  it("rejects negative block numbers", () => {
    expect(() => computeBlockRanges(-1, 100, 10)).toThrow(RangeError);
  });
});
