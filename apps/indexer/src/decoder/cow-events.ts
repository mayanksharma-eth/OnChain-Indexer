import type { Address, Hex } from "viem";
import type { RawLogMeta } from "./events.js";

export interface CowTradeEvent {
  eventName: "Trade";
  args: {
    owner: Address;
    sellToken: Address;
    buyToken: Address;
    sellAmount: bigint;
    buyAmount: bigint;
    feeAmount: bigint;
    orderUid: Hex;
  };
  raw: RawLogMeta;
}

export interface CowSettlementEvent {
  eventName: "Settlement";
  args: {
    solver: Address;
  };
  raw: RawLogMeta;
}

export interface CowOrderInvalidatedEvent {
  eventName: "OrderInvalidated";
  args: {
    owner: Address;
    orderUid: Hex;
  };
  raw: RawLogMeta;
}

export type DecodedCowEvent = CowTradeEvent | CowSettlementEvent | CowOrderInvalidatedEvent;
