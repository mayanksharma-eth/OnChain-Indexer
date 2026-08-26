import { parseAbi } from "viem";

export const intentAbi = parseAbi([
  "event IntentCreated(bytes32 indexed intentId, address indexed owner, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 deadline)",
  "event IntentCancelled(bytes32 indexed intentId, address indexed owner)",
  "event IntentFilled(bytes32 indexed intentId, address indexed solver, uint256 amountIn, uint256 amountOut)",
]);
