import { decodeEventLog, getAddress, type Log } from "viem";
import { cowSettlementAbi } from "@onchain-indexer/abi";
import { toRawLogMeta } from "./events.js";
import type { DecodedCowEvent } from "./cow-events.js";

/**
 * Decodes a single log against the CoW GPv2Settlement ABI (Trade/Settlement/OrderInvalidated
 * only — see packages/abi/src/cow.ts). Returns undefined for logs whose topic0 doesn't match one
 * of these three events (e.g. Interaction, PreSignature, or an unrelated contract's log if
 * CONTRACT_ADDRESS were ever misconfigured), same drop-not-error contract as decodeIntentLog.
 */
export function decodeCowLog(log: Log): DecodedCowEvent | undefined {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: cowSettlementAbi, data: log.data, topics: log.topics, strict: true });
  } catch {
    return undefined;
  }

  const raw = toRawLogMeta(log);

  switch (decoded.eventName) {
    case "Trade":
      return {
        eventName: "Trade",
        raw,
        args: {
          owner: getAddress(decoded.args.owner),
          sellToken: getAddress(decoded.args.sellToken),
          buyToken: getAddress(decoded.args.buyToken),
          sellAmount: decoded.args.sellAmount,
          buyAmount: decoded.args.buyAmount,
          feeAmount: decoded.args.feeAmount,
          orderUid: decoded.args.orderUid,
        },
      };
    case "Settlement":
      return {
        eventName: "Settlement",
        raw,
        args: {
          solver: getAddress(decoded.args.solver),
        },
      };
    case "OrderInvalidated":
      return {
        eventName: "OrderInvalidated",
        raw,
        args: {
          owner: getAddress(decoded.args.owner),
          orderUid: decoded.args.orderUid,
        },
      };
  }
}

/** Decodes a batch of logs, silently dropping any that aren't one of the three tracked events. */
export function decodeCowLogs(logs: readonly Log[]): DecodedCowEvent[] {
  const decoded: DecodedCowEvent[] = [];
  for (const log of logs) {
    const event = decodeCowLog(log);
    if (event) decoded.push(event);
  }
  return decoded;
}
