// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAavePool
 * @notice Minimal interface for Aave V3 Pool operations used by DeFiInteractor
 */
interface IAavePool {
    /// @notice Supply assets to the Aave pool
    /// @param asset The address of the underlying asset to supply
    /// @param amount The amount to be supplied
    /// @param onBehalfOf The address that will receive the aTokens
    /// @param referralCode Referral code (use 0 if not applicable)
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /// @notice Withdraw assets from the Aave pool
    /// @param asset The address of the underlying asset to withdraw
    /// @param amount The amount to be withdrawn (use type(uint256).max for full balance)
    /// @param to The address that will receive the underlying asset
    /// @return The final amount withdrawn
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
