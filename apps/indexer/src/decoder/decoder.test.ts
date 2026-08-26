import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type AbiEvent, type Log } from "viem";
import { erc20Abi, intentAbi } from "@onchain-indexer/abi";
import { describe, expect, it } from "vitest";
import { decodeIntentLog, decodeIntentLogs } from "./decoder.js";

const addr = (char: string) => `0x${char.repeat(40)}` as const;
const CONTRACT = addr("a");
const OWNER = addr("b");
const SOLVER = addr("c");
const TOKEN_IN = addr("d");
const TOKEN_OUT = addr("e");
const INTENT_ID = keccak256(toHex("intent-1"));

/** Builds a real topics/data pair the way an EVM node would emit it, via viem's own ABI encoders. */
function encodeEventLog<const abi extends Abi>(params: {
  abi: abi;
  eventName: string;
  args: Record<string, unknown>;
}): { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` } {
  const topics = encodeEventTopics(params as never) as [`0x${string}`, ...`0x${string}`[]];
  const item = params.abi.find(
    (i): i is AbiEvent => i.type === "event" && i.name === params.eventName,
  )!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((input) => params.args[input.name!]),
  );
  return { topics, data };
}

function buildLog(encoded: { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] }, overrides: Partial<Log> = {}): Log {
  return {
    address: CONTRACT,
    data: encoded.data,
    topics: encoded.topics,
    blockHash: "0xblockhash000000000000000000000000000000000000000000000000000",
    blockNumber: 100n,
    transactionHash: "0xtxhash00000000000000000000000000000000000000000000000000000",
    transactionIndex: 1,
    logIndex: 2,
    removed: false,
    ...overrides,
  } as Log;
}

describe("decodeIntentLog", () => {
  it("decodes a known-good IntentCreated log and normalizes addresses", () => {
    const encoded = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentCreated",
      args: {
        intentId: INTENT_ID,
        owner: OWNER,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000n,
        minAmountOut: 900n,
        deadline: 9_999_999n,
      },
    });

    const decoded = decodeIntentLog(buildLog(encoded));

    expect(decoded).toEqual({
      eventName: "IntentCreated",
      args: {
        intentId: INTENT_ID,
        owner: expect.stringMatching(/^0x/i),
        tokenIn: expect.stringMatching(/^0x/i),
        tokenOut: expect.stringMatching(/^0x/i),
        amountIn: 1_000n,
        minAmountOut: 900n,
        deadline: 9_999_999n,
      },
      raw: {
        address: CONTRACT,
        blockHash: "0xblockhash000000000000000000000000000000000000000000000000000",
        blockNumber: 100n,
        transactionHash: "0xtxhash00000000000000000000000000000000000000000000000000000",
        transactionIndex: 1,
        logIndex: 2,
        removed: false,
        topics: encoded.topics,
      },
    });
    // normalized to EIP-55 checksum casing, not the raw lowercase input
    const created = decoded as Extract<typeof decoded, { eventName: "IntentCreated" }>;
    expect(created.args.owner).not.toBe(OWNER);
    expect(created.args.owner.toLowerCase()).toBe(OWNER);
  });

  it("decodes a known-good IntentCancelled log", () => {
    const encoded = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentCancelled",
      args: { intentId: INTENT_ID, owner: OWNER },
    });

    const decoded = decodeIntentLog(buildLog(encoded));

    expect(decoded?.eventName).toBe("IntentCancelled");
    expect(decoded?.args).toEqual({ intentId: INTENT_ID, owner: expect.stringMatching(/^0x/i) });
  });

  it("decodes a known-good IntentFilled log", () => {
    const encoded = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentFilled",
      args: { intentId: INTENT_ID, solver: SOLVER, amountIn: 1_000n, amountOut: 950n },
    });

    const decoded = decodeIntentLog(buildLog(encoded));

    expect(decoded).toMatchObject({
      eventName: "IntentFilled",
      args: { intentId: INTENT_ID, amountIn: 1_000n, amountOut: 950n },
    });
  });

  it("preserves raw log metadata untouched alongside the decoded args", () => {
    const encoded = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentCancelled",
      args: { intentId: INTENT_ID, owner: OWNER },
    });

    const decoded = decodeIntentLog(
      buildLog(encoded, { blockNumber: 42n, transactionIndex: 7, logIndex: 3 }),
    );

    expect(decoded?.raw).toMatchObject({ blockNumber: 42n, transactionIndex: 7, logIndex: 3 });
  });

  it("safely ignores logs for events not in the intent ABI (e.g. ERC20 Transfer)", () => {
    const encoded = encodeEventLog({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: OWNER, to: SOLVER, value: 1n },
    });

    expect(decodeIntentLog(buildLog(encoded))).toBeUndefined();
  });

  it("safely ignores a log with an unrecognized topic0", () => {
    const log = buildLog({
      data: "0x",
      topics: [keccak256(toHex("SomeOtherEvent(uint256)"))],
    });

    expect(decodeIntentLog(log)).toBeUndefined();
  });

  it("safely ignores a malformed log that claims a known topic0 but has truncated data", () => {
    const encoded = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentCreated",
      args: {
        intentId: INTENT_ID,
        owner: OWNER,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1_000n,
        minAmountOut: 900n,
        deadline: 9_999_999n,
      },
    });

    const truncated = buildLog({ ...encoded, data: encoded.data.slice(0, 20) as `0x${string}` });

    expect(decodeIntentLog(truncated)).toBeUndefined();
  });
});

describe("decodeIntentLogs", () => {
  it("decodes a mixed batch, dropping unknown events while preserving order of the known ones", () => {
    const created = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentCreated",
      args: {
        intentId: INTENT_ID,
        owner: OWNER,
        tokenIn: TOKEN_IN,
        tokenOut: TOKEN_OUT,
        amountIn: 1n,
        minAmountOut: 1n,
        deadline: 1n,
      },
    });
    const unrelated = encodeEventLog({ abi: erc20Abi, eventName: "Transfer", args: { from: OWNER, to: SOLVER, value: 1n } });
    const filled = encodeEventLog({
      abi: intentAbi,
      eventName: "IntentFilled",
      args: { intentId: INTENT_ID, solver: SOLVER, amountIn: 1n, amountOut: 1n },
    });

    const logs = [buildLog(created, { logIndex: 0 }), buildLog(unrelated, { logIndex: 1 }), buildLog(filled, { logIndex: 2 })];

    const decoded = decodeIntentLogs(logs);

    expect(decoded).toHaveLength(2);
    expect(decoded.map((e) => e.eventName)).toEqual(["IntentCreated", "IntentFilled"]);
  });
});
