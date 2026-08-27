// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Demo-only contract emitting the exact event signatures decoded by packages/abi/src/intent.ts.
/// Not part of the product; used solely to drive the end-to-end demo against a local anvil chain.
contract Intent {
    event IntentCreated(
        bytes32 indexed intentId,
        address indexed owner,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    );
    event IntentCancelled(bytes32 indexed intentId, address indexed owner);
    event IntentFilled(bytes32 indexed intentId, address indexed solver, uint256 amountIn, uint256 amountOut);

    function createIntent(
        bytes32 intentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external {
        emit IntentCreated(intentId, msg.sender, tokenIn, tokenOut, amountIn, minAmountOut, deadline);
    }

    function cancelIntent(bytes32 intentId) external {
        emit IntentCancelled(intentId, msg.sender);
    }

    function fillIntent(bytes32 intentId, uint256 amountIn, uint256 amountOut) external {
        emit IntentFilled(intentId, msg.sender, amountIn, amountOut);
    }
}
