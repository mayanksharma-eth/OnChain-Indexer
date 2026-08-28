import { parseAbi } from "viem";

/**
 * CoW Protocol's GPv2Settlement contract — the single onchain settlement contract for CoW
 * Protocol, deployed at the same deterministic address on every supported chain (Ethereum
 * mainnet, Gnosis Chain, Arbitrum, Base, etc): 0x9008D19f58AAbD9eD0D60971565AA8510560ab41.
 *
 * Event signatures verified verbatim against the official source, not guessed:
 * https://github.com/cowprotocol/contracts/blob/main/src/contracts/GPv2Settlement.sol
 * https://github.com/cowprotocol/contracts/blob/main/src/contracts/mixins/GPv2Signing.sol
 *
 * Only the three events relevant to onchain solver execution state are included here — the
 * contract also emits `Interaction(address indexed target, uint256 value, bytes4 selector)`
 * (internal call-trace metadata, not order data) and `PreSignature(address indexed owner, bytes
 * orderUid, bool signed)` (offchain order pre-sign bookkeeping, not settlement execution) which
 * this indexer deliberately does not track.
 */
export const cowSettlementAbi = parseAbi([
  "event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)",
  "event Settlement(address indexed solver)",
  "event OrderInvalidated(address indexed owner, bytes orderUid)",
]);

/** GPv2Settlement's deterministic address — identical across every chain it's deployed to. */
export const COW_SETTLEMENT_ADDRESS = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;
