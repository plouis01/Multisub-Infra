// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISpendSettler {
    // ============ Events ============

    /// @notice Emitted when a card spend is settled on-chain
    event SpendSettled(
        address indexed m2Safe, address indexed issuerSafe, uint256 amount, bytes32 indexed lithicTxToken, uint256 nonce
    );

    event SettlerUpdated(address indexed previousSettler, address indexed newSettler);
    event IssuerSafeUpdated(address indexed previousIssuer, address indexed newIssuer);
    event UsdcAddressUpdated(address indexed previousUsdc, address indexed newUsdc);

    // ============ Core Settlement ============

    /// @notice Settle a card transaction by transferring USDC from M2 Safe to Issuer Safe
    /// @param amount USDC amount to settle (6 decimals for USDC)
    /// @param lithicTxToken Unique Lithic transaction token for idempotency
    function settle(uint256 amount, bytes32 lithicTxToken) external;

    // ============ View Functions ============

    function getRollingSpend() external view returns (uint256);
    function getTotalSettled() external view returns (uint256);
    function isSettled(bytes32 lithicTxToken) external view returns (bool);
}
