// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITreasuryVault
 * @notice Interface for the M1 Treasury vault with ERC-4626 per-tenant share accounting
 * @dev Wraps an underlying Morpho vault position with per-tenant share tracking
 */
interface ITreasuryVault {
    // ============ Structs ============

    struct TenantPosition {
        uint256 shares; // Shares in the underlying Morpho vault attributed to this tenant
        uint256 depositedAmount; // Total USDC deposited (for yield calculation)
        uint256 lastSnapshotYield; // Yield at last snapshot (18 decimals)
        uint256 lastSnapshotTime; // Timestamp of last yield snapshot
    }

    // ============ Events ============

    event TenantDeposit(bytes32 indexed tenantId, uint256 usdcAmount, uint256 sharesMinted);
    event TenantWithdraw(bytes32 indexed tenantId, uint256 usdcAmount, uint256 sharesBurned);
    event YieldSnapshot(bytes32 indexed tenantId, uint256 yieldAmount, uint256 timestamp);
    event GlobalYieldSnapshot(uint256 tenantCount, uint256 timestamp);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event MorphoVaultUpdated(address indexed oldVault, address indexed newVault);

    // ============ Core Functions ============

    function depositForTenant(bytes32 tenantId, uint256 usdcAmount) external returns (uint256 shares);
    function withdrawForTenant(bytes32 tenantId, uint256 usdcAmount) external returns (uint256 sharesBurned);

    // ============ Yield Functions ============

    function getYieldForTenant(bytes32 tenantId) external view returns (uint256 yield_);
    function snapshotYield(bytes32[] calldata tenantIds) external;

    // ============ View Functions ============

    function getTenantPosition(bytes32 tenantId) external view returns (TenantPosition memory);
    function getTenantShares(bytes32 tenantId) external view returns (uint256);
    function getTenantDeposited(bytes32 tenantId) external view returns (uint256);
    function operator() external view returns (address);
    function morphoVault() external view returns (address);
    function usdc() external view returns (address);
}
