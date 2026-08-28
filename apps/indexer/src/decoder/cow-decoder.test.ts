import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi, type AbiEvent, type Log } from "viem";
import { cowSettlementAbi, erc20Abi } from "@onchain-indexer/abi";
import { describe, expect, it } from "vitest";
import { decodeCowLog, decodeCowLogs } from "./cow-decoder.js";

const addr = (char: string) => `0x${char.repeat(40)}` as const;
const CONTRACT = addr("a");
const OWNER = addr("b");
const SOLVER = addr("c");
const SELL_TOKEN = addr("d");
const BUY_TOKEN = addr("e");
/** A real-shaped 56-byte packed orderUid (orderDigest[32] || owner[20] || validTo[4]). */
const ORDER_UID = `0x${"11".repeat(32)}${OWNER.slice(2)}${"deadbeef"}` as const;

function encodeEventLog<const abi extends Abi>(params: {
  abi: abi;
  eventName: string;
  args: Record<string, unknown>;
}): { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` } {
  const topics = encodeEventTopics(params as never) as [`0x${string}`, ...`0x${string}`[]];
  const item = params.abi.find((i): i is AbiEvent => i.type === "event" && i.name === params.eventName)!;
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input) => params.args[input.name!]));
  return { topics, data };
}

function buildLog(encoded: { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] }, overrides: Partial<Log> = {}): Log {
  return {
    address: CONTRACT,
    data: encoded.data,
    topics: encoded.topics,
    blockHash: "0xblockhash000000000000000000000000000000000000000000000000000",
    blockNumber: 21_000_000n,
    transactionHash: "0xtxhash00000000000000000000000000000000000000000000000000000",
    transactionIndex: 1,
    logIndex: 2,
    removed: false,
    ...overrides,
  };
}

describe("decodeCowLog", () => {
  it("decodes a known-good Trade log and normalizes addresses", () => {
    const encoded = encodeEventLog({
      abi: cowSettlementAbi,
      eventName: "Trade",
      args: {
        owner: OWNER,
        sellToken: SELL_TOKEN,
        buyToken: BUY_TOKEN,
        sellAmount: 1_000_000_000n,
        buyAmount: 950_000_000n,
        feeAmount: 1_000n,
        orderUid: ORDER_UID,
      },
    });

    const decoded = decodeCowLog(buildLog(encoded));

    expect(decoded).toMatchObject({
      eventName: "Trade",
      args: {
        sellAmount: 1_000_000_000n,
        buyAmount: 950_000_000n,
        feeAmount: 1_000n,
        orderUid: ORDER_UID,
      },
    });
    const trade = decoded as Extract<typeof decoded, { eventName: "Trade" }>;
    // normalized to EIP-55 checksum casing, not the raw lowercase input
    expect(trade.args.owner).not.toBe(OWNER);
    expect(trade.args.owner.toLowerCase()).toBe(OWNER);
  });

  it("decodes a known-good Settlement log", () => {
    const encoded = encodeEventLog({ abi: cowSettlementAbi, eventName: "Settlement", args: { solver: SOLVER } });

    const decoded = decodeCowLog(buildLog(encoded));

    expect(decoded?.eventName).toBe("Settlement");
    expect(decoded?.args).toMatchObject({});
    const settlement = decoded as Extract<typeof decoded, { eventName: "Settlement" }>;
    expect(settlement.args.solver.toLowerCase()).toBe(SOLVER);
  });

  it("decodes a known-good OrderInvalidated log", () => {
    const encoded = encodeEventLog({
      abi: cowSettlementAbi,
      eventName: "OrderInvalidated",
      args: { owner: OWNER, orderUid: ORDER_UID },
    });

    const decoded = decodeCowLog(buildLog(encoded));

    expect(decoded).toMatchObject({ eventName: "OrderInvalidated", args: { orderUid: ORDER_UID } });
  });

  it("preserves raw log metadata untouched alongside the decoded args", () => {
    const encoded = encodeEventLog({ abi: cowSettlementAbi, eventName: "Settlement", args: { solver: SOLVER } });

    const decoded = decodeCowLog(buildLog(encoded, { blockNumber: 42n, transactionIndex: 7, logIndex: 3 }));

    expect(decoded?.raw).toMatchObject({ blockNumber: 42n, transactionIndex: 7, logIndex: 3 });
  });

  it("safely ignores logs for events not in the CoW ABI (e.g. ERC20 Transfer)", () => {
    const encoded = encodeEventLog({ abi: erc20Abi, eventName: "Transfer", args: { from: OWNER, to: SOLVER, value: 1n } });

    expect(decodeCowLog(buildLog(encoded))).toBeUndefined();
  });

  it("safely ignores Interaction/PreSignature-shaped logs this indexer deliberately doesn't track", () => {
    // Interaction(address indexed target, uint256 value, bytes4 selector) -- not in cowSettlementAbi
    const log = buildLog({
      data: "0x",
      topics: [keccak256(toHex("Interaction(address,uint256,bytes4)"))],
    });

    expect(decodeCowLog(log)).toBeUndefined();
  });

  it("safely ignores a malformed log that claims a known topic0 but has truncated data", () => {
    const encoded = encodeEventLog({
      abi: cowSettlementAbi,
      eventName: "OrderInvalidated",
      args: { owner: OWNER, orderUid: ORDER_UID },
    });
    const truncated = buildLog({ ...encoded, data: encoded.data.slice(0, 20) as `0x${string}` });

    expect(decodeCowLog(truncated)).toBeUndefined();
  });
});

describe("decodeCowLogs", () => {
  it("decodes a mixed batch, dropping unknown events while preserving order of the known ones", () => {
    const trade = encodeEventLog({
      abi: cowSettlementAbi,
      eventName: "Trade",
      args: {
        owner: OWNER,
        sellToken: SELL_TOKEN,
        buyToken: BUY_TOKEN,
        sellAmount: 1n,
        buyAmount: 1n,
        feeAmount: 1n,
        orderUid: ORDER_UID,
      },
    });
    const unrelated = encodeEventLog({ abi: erc20Abi, eventName: "Transfer", args: { from: OWNER, to: SOLVER, value: 1n } });
    const settlement = encodeEventLog({ abi: cowSettlementAbi, eventName: "Settlement", args: { solver: SOLVER } });

    const logs = [buildLog(trade, { logIndex: 0 }), buildLog(unrelated, { logIndex: 1 }), buildLog(settlement, { logIndex: 2 })];

    const decoded = decodeCowLogs(logs);

    expect(decoded).toHaveLength(2);
    expect(decoded.map((e) => e.eventName)).toEqual(["Trade", "Settlement"]);
  });
});
