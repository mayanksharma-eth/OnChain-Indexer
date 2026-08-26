import { decodeEventLog, getAddress, type Log } from "viem";
import { intentAbi } from "@onchain-indexer/abi";
import { toRawLogMeta, type DecodedIntentEvent } from "./events.js";

/**
 * Decodes a single log against the intent protocol ABI.
 * Returns undefined for logs whose topic0 doesn't match a known event, or whose
 * data/topics don't match the event's shape (truncated log, ABI drift, etc.) —
 * callers can safely map+filter over arbitrary chain logs without pre-filtering.
 */
export function decodeIntentLog(log: Log): DecodedIntentEvent | undefined {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: intentAbi, data: log.data, topics: log.topics, strict: true });
  } catch {
    return undefined;
  }

  const raw = toRawLogMeta(log);

  switch (decoded.eventName) {
    case "IntentCreated":
      return {
        eventName: "IntentCreated",
        raw,
        args: {
          intentId: decoded.args.intentId,
          owner: getAddress(decoded.args.owner),
          tokenIn: getAddress(decoded.args.tokenIn),
          tokenOut: getAddress(decoded.args.tokenOut),
          amountIn: decoded.args.amountIn,
          minAmountOut: decoded.args.minAmountOut,
          deadline: decoded.args.deadline,
        },
      };
    case "IntentCancelled":
      return {
        eventName: "IntentCancelled",
        raw,
        args: {
          intentId: decoded.args.intentId,
          owner: getAddress(decoded.args.owner),
        },
      };
    case "IntentFilled":
      return {
        eventName: "IntentFilled",
        raw,
        args: {
          intentId: decoded.args.intentId,
          solver: getAddress(decoded.args.solver),
          amountIn: decoded.args.amountIn,
          amountOut: decoded.args.amountOut,
        },
      };
  }
}

/** Decodes a batch of logs, silently dropping any that aren't known intent events. */
export function decodeIntentLogs(logs: readonly Log[]): DecodedIntentEvent[] {
  const decoded: DecodedIntentEvent[] = [];
  for (const log of logs) {
    const event = decodeIntentLog(log);
    if (event) decoded.push(event);
  }
  return decoded;
}
