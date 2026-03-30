// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMorphoVault} from "./interfaces/IMorphoVault.sol";
import {ITreasuryVault} from "./interfaces/ITreasuryVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TreasuryVault
/// @notice ERC-4626 per-tenant share accounting wrapper for the M1 Treasury Safe.
///         Tracks each tenant's share of an underlying Morpho vault position.
/// @dev NOT a standalone ERC-4626 vault. This is a module attached to the M1 Safe
///      that deposits/withdraws through the Safe and maintains per-tenant accounting
///      of the resulting vault shares. Yield is calculated as the difference between
///      current share value and total deposited amount.
contract TreasuryVault is Module, ReentrancyGuard, Pausable, ITreasuryVault {
    // ============ State ============

    /// @notice Authorized yield manager service address
    address public override operator;

    /// @notice The Morpho vault where USDC is deposited
    address public override morphoVault;

    /// @notice USDC token address
    address public override usdc;

    /// @notice Per-tenant position tracking
    mapping(bytes32 => TenantPosition) private _tenantPositions;

    /// @notice Total shares across all tenants (for accounting validation)
    uint256 public totalTenantShares;

    /// @notice Total USDC deposited across all tenants
    uint256 public totalDeposited;

    // ============ Constants ============

    /// @notice Maximum number of tenants per snapshotYield batch to prevent DoS via gas exhaustion
    uint256 public constant MAX_SNAPSHOT_BATCH = 100;

    // ============ Errors ============

    error OnlyOperator();
    error OnlyOperatorOrOwner();
    error InvalidOperator();
    error InvalidMorphoVault();
    error InvalidUsdcAddress();
    error ZeroAmount();
    error ZeroTenantId();
    error InsufficientShares(bytes32 tenantId, uint256 requested, uint256 available);
    error InsufficientDeposited(bytes32 tenantId, uint256 requested, uint256 available);
    error ExecutionFailed();
    error BatchTooLarge(uint256 provided, uint256 max);
    error PositionsExist(uint256 totalShares);
    error ZeroSharesMinted();
    error SlippageExceeded(uint256 actual, uint256 limit);

    // ============ Events ============

    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    // ============ Modifiers ============

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner) revert OnlyOperatorOrOwner();
        _;
    }

    // ============ Constructor ============

    /// @param _avatar The M1 Safe address this module is attached to
    /// @param _owner Owner (typically the M1 Safe or admin multisig)
    /// @param _operator Address of the yield manager service backend
    /// @param _morphoVault The Morpho vault address for USDC deposits
    /// @param _usdc USDC token contract address
    constructor(address _avatar, address _owner, address _operator, address _morphoVault, address _usdc)
        Module(_avatar, _avatar, _owner)
    {
        if (_operator == address(0)) revert InvalidOperator();
        if (_morphoVault == address(0)) revert InvalidMorphoVault();
        if (_usdc == address(0)) revert InvalidUsdcAddress();

        operator = _operator;
        morphoVault = _morphoVault;
        usdc = _usdc;

        emit OperatorUpdated(address(0), _operator);
        emit MorphoVaultUpdated(address(0), _morphoVault);
    }

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============ Core Operations ============

    /// @notice Deposit USDC into the Morpho vault on behalf of a tenant
    /// @param tenantId The tenant identifier
    /// @param usdcAmount Amount of USDC to deposit
    /// @param minShares Minimum shares to receive (slippage protection, 0 to skip)
    /// @return shares Amount of Morpho vault shares minted for this tenant
    function depositForTenant(bytes32 tenantId, uint256 usdcAmount, uint256 minShares)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (tenantId == bytes32(0)) revert ZeroTenantId();
        if (usdcAmount == 0) revert ZeroAmount();

        // Snapshot share balance before deposit
        uint256 sharesBefore = IMorphoVault(morphoVault).balanceOf(avatar);

        // Step 1: Approve the Morpho vault to spend USDC from the Safe
        bytes memory approveData = abi.encodeWithSelector(IERC20.approve.selector, morphoVault, usdcAmount);
        bool approveSuccess = exec(usdc, 0, approveData, ISafe.Operation.Call);
        if (!approveSuccess) revert ExecutionFailed();

        // Step 2: Deposit USDC into Morpho vault with Safe as receiver
        bytes memory depositData = abi.encodeWithSelector(IMorphoVault.deposit.selector, usdcAmount, avatar);
        bool depositSuccess = exec(morphoVault, 0, depositData, ISafe.Operation.Call);
        if (!depositSuccess) revert ExecutionFailed();

        // Reset approval to 0 to prevent lingering allowance
        bytes memory resetApproval = abi.encodeWithSelector(IERC20.approve.selector, morphoVault, uint256(0));
        exec(usdc, 0, resetApproval, ISafe.Operation.Call);
        // Best effort — don't check return

        // Measure actual shares minted via before/after balance snapshot
        uint256 sharesAfter = IMorphoVault(morphoVault).balanceOf(avatar);
        shares = sharesAfter - sharesBefore;

        // Revert if zero shares minted (prevents accounting corruption)
        if (shares == 0) revert ZeroSharesMinted();

        // Slippage check
        if (shares < minShares) revert SlippageExceeded(shares, minShares);

        // Update tenant position
        TenantPosition storage pos = _tenantPositions[tenantId];
        pos.shares += shares;
        pos.depositedAmount += usdcAmount;

        // Update global totals
        totalTenantShares += shares;
        totalDeposited += usdcAmount;

        emit TenantDeposit(tenantId, usdcAmount, shares);
    }

    /// @notice Withdraw USDC from the Morpho vault on behalf of a tenant
    /// @param tenantId The tenant identifier
    /// @param usdcAmount Amount of USDC to withdraw
    /// @param maxSharesBurned Maximum shares to burn (slippage protection, 0 to skip)
    /// @return sharesBurned Amount of Morpho vault shares burned for this tenant
    function withdrawForTenant(bytes32 tenantId, uint256 usdcAmount, uint256 maxSharesBurned)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 sharesBurned)
    {
        if (tenantId == bytes32(0)) revert ZeroTenantId();
        if (usdcAmount == 0) revert ZeroAmount();

        TenantPosition storage pos = _tenantPositions[tenantId];

        // Pre-check uses previewWithdraw (rounds UP per ERC-4626) instead of convertToShares
        uint256 estimatedShares = IMorphoVault(morphoVault).previewWithdraw(usdcAmount);
        if (estimatedShares > pos.shares) {
            revert InsufficientShares(tenantId, estimatedShares, pos.shares);
        }

        // Snapshot share balance before withdrawal
        uint256 sharesBefore = IMorphoVault(morphoVault).balanceOf(avatar);

        // Withdraw from Morpho vault — receiver and owner are both the Safe (avatar)
        bytes memory withdrawData = abi.encodeWithSelector(IMorphoVault.withdraw.selector, usdcAmount, avatar, avatar);
        bool success = exec(morphoVault, 0, withdrawData, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        // Measure actual shares burned via before/after balance snapshot
        uint256 sharesAfter = IMorphoVault(morphoVault).balanceOf(avatar);
        sharesBurned = sharesBefore - sharesAfter;

        // Validate tenant has enough shares (post-withdraw check)
        if (sharesBurned > pos.shares) {
            revert InsufficientShares(tenantId, sharesBurned, pos.shares);
        }

        // Slippage check
        if (maxSharesBurned > 0 && sharesBurned > maxSharesBurned) {
            revert SlippageExceeded(sharesBurned, maxSharesBurned);
        }

        // Proportional basis reduction (compute BEFORE decrementing shares)
        uint256 depositReduction = pos.depositedAmount * sharesBurned / pos.shares;
        pos.shares -= sharesBurned;
        pos.depositedAmount -= depositReduction;
        // Clean up: if all shares gone, zero out deposited to prevent phantom residual
        if (pos.shares == 0) pos.depositedAmount = 0;

        // Update global totals
        totalTenantShares -= sharesBurned;
        totalDeposited -= depositReduction;

        emit TenantWithdraw(tenantId, usdcAmount, sharesBurned);
    }

    /// @notice Redeem shares from the Morpho vault on behalf of a tenant (for loss scenarios)
    /// @dev Use when the vault has lost value and withdrawing by USDC amount would fail
    /// @param tenantId The tenant identifier
    /// @param shares Amount of Morpho vault shares to redeem
    /// @param minAssetsOut Minimum assets to receive (slippage protection, 0 to skip)
    /// @return assetsReceived Amount of USDC received from the redemption
    function redeemForTenant(bytes32 tenantId, uint256 shares, uint256 minAssetsOut)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 assetsReceived)
    {
        if (tenantId == bytes32(0)) revert ZeroTenantId();
        if (shares == 0) revert ZeroAmount();

        TenantPosition storage pos = _tenantPositions[tenantId];
        if (shares > pos.shares) revert InsufficientShares(tenantId, shares, pos.shares);

        uint256 assetsBefore = IERC20(usdc).balanceOf(avatar);

        bytes memory redeemData = abi.encodeWithSelector(IMorphoVault.redeem.selector, shares, avatar, avatar);
        bool success = exec(morphoVault, 0, redeemData, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        uint256 assetsAfter = IERC20(usdc).balanceOf(avatar);
        assetsReceived = assetsAfter - assetsBefore;

        // Slippage check
        if (assetsReceived < minAssetsOut) revert SlippageExceeded(assetsReceived, minAssetsOut);

        // Proportional basis reduction (compute BEFORE decrementing shares)
        uint256 depositReduction = pos.depositedAmount * shares / pos.shares;
        pos.shares -= shares;
        pos.depositedAmount -= depositReduction;
        // Clean up: if all shares gone, zero out deposited to prevent phantom residual
        if (pos.shares == 0) pos.depositedAmount = 0;

        // Update global totals
        totalTenantShares -= shares;
        totalDeposited -= depositReduction;

        emit TenantWithdraw(tenantId, assetsReceived, shares);
    }

    // ============ Yield Functions ============

    /// @notice Calculate unrealized yield for a tenant
    /// @param tenantId The tenant identifier
    /// @return yield_ The yield amount in USDC (can be 0 if no yield yet)
    function getYieldForTenant(bytes32 tenantId) external view override returns (uint256 yield_) {
        TenantPosition storage pos = _tenantPositions[tenantId];
        if (pos.shares == 0) return 0;

        // Current value of tenant's shares in USDC
        uint256 currentValue = IMorphoVault(morphoVault).convertToAssets(pos.shares);

        // Yield = current value - deposited amount
        if (currentValue > pos.depositedAmount) {
            yield_ = currentValue - pos.depositedAmount;
        }
    }

    /// @notice Record yield snapshots for a list of tenants
    /// @dev Called every 4h by the yield manager service
    /// @param tenantIds Array of tenant identifiers to snapshot
    function snapshotYield(bytes32[] calldata tenantIds) external override onlyOperatorOrOwner whenNotPaused {
        if (tenantIds.length > MAX_SNAPSHOT_BATCH) revert BatchTooLarge(tenantIds.length, MAX_SNAPSHOT_BATCH);

        for (uint256 i = 0; i < tenantIds.length; i++) {
            bytes32 tenantId = tenantIds[i];
            TenantPosition storage pos = _tenantPositions[tenantId];

            if (pos.shares == 0) continue;

            uint256 currentValue = IMorphoVault(morphoVault).convertToAssets(pos.shares);
            uint256 yieldAmount = 0;
            if (currentValue > pos.depositedAmount) {
                yieldAmount = currentValue - pos.depositedAmount;
            }

            pos.lastSnapshotYield = yieldAmount;
            pos.lastSnapshotTime = block.timestamp;

            emit YieldSnapshot(tenantId, yieldAmount, block.timestamp);
        }

        emit GlobalYieldSnapshot(tenantIds.length, block.timestamp);
    }

    // ============ Admin Functions ============

    /// @notice Update the operator (yield manager service) address
    /// @param newOperator The new operator address
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidOperator();
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /// @notice Update the Morpho vault address
    /// @dev Reverts if any tenant positions exist to prevent share accounting corruption
    /// @param newVault The new Morpho vault address
    function setMorphoVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert InvalidMorphoVault();
        if (totalTenantShares > 0) revert PositionsExist(totalTenantShares);
        address oldVault = morphoVault;
        morphoVault = newVault;
        emit MorphoVaultUpdated(oldVault, newVault);
    }

    // ============ View Functions ============

    /// @notice Get the full position details for a tenant
    function getTenantPosition(bytes32 tenantId) external view override returns (TenantPosition memory) {
        return _tenantPositions[tenantId];
    }

    /// @notice Get the share balance for a tenant
    function getTenantShares(bytes32 tenantId) external view override returns (uint256) {
        return _tenantPositions[tenantId].shares;
    }

    /// @notice Get the total deposited amount for a tenant
    function getTenantDeposited(bytes32 tenantId) external view override returns (uint256) {
        return _tenantPositions[tenantId].depositedAmount;
    }
}
