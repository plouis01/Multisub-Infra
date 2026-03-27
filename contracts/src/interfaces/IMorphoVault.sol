// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMorphoVault
 * @notice Simplified ERC4626-compliant interface for Morpho Vault interactions
 * @dev Only includes functions needed by DeFiInteractor and TreasuryVault modules
 */
interface IMorphoVault {
    // ============ ERC4626 Core Functions ============

    /// @notice Deposit assets into the vault
    /// @param assets Amount of assets to deposit
    /// @param receiver Address that will receive the shares
    /// @return shares Amount of shares minted
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Withdraw assets from the vault
    /// @param assets Amount of assets to withdraw
    /// @param receiver Address that will receive the assets
    /// @param owner Address of the share owner
    /// @return shares Amount of shares burned
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /// @notice Redeem shares for assets
    /// @param shares Amount of shares to redeem
    /// @param receiver Address that will receive the assets
    /// @param owner Address of the share owner
    /// @return assets Amount of assets received
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    // ============ ERC4626 View Functions ============

    /// @notice Get the underlying asset address
    function asset() external view returns (address);

    /// @notice Convert shares to assets
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /// @notice Convert assets to shares
    function convertToShares(uint256 assets) external view returns (uint256 shares);

    /// @notice Preview redeem effects
    function previewRedeem(uint256 shares) external view returns (uint256 assets);

    // ============ ERC20 Functions ============

    /// @notice Get balance of shares for an account
    function balanceOf(address account) external view returns (uint256);
}
