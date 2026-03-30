// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IMorphoVault} from "./interfaces/IMorphoVault.sol";
import {IAavePool} from "./interfaces/IAavePool.sol";
import {IDeFiInteractor} from "./interfaces/IDeFiInteractor.sol";
import {ITreasuryVault} from "./interfaces/ITreasuryVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title DeFiInteractor
/// @notice Zodiac module for M1 Treasury Safe that executes DeFi operations on
///         Morpho vaults and Aave v3. Stripped of generic routing — hardcoded to
///         known protocols with vault allowlisting and receiver validation.
/// @dev Replaces the Bank DeFiInteractor with a simplified, hardcoded module.
///      No parser architecture or generic routing. Only the yield manager service
///      (operator) can call execution functions.
contract DeFiInteractor is Module, ReentrancyGuard, Pausable, IDeFiInteractor {
    // ============ State ============

    /// @notice Authorized yield manager service address
    address public override operator;

    /// @notice TreasuryVault address for cross-module share desync protection
    address public override treasuryVault;

    /// @notice Allowlisted vault/pool addresses
    mapping(address => bool) public override isAllowlistedVault;

    // ============ Errors ============

    error OnlyOperator();
    error VaultNotAllowlisted(address vault);
    error InvalidReceiver(address receiver, address expected);
    error InvalidOperator();
    error InvalidVault();
    error VaultAlreadyAllowlisted(address vault);
    error VaultNotFound(address vault);
    error ZeroAmount();
    error ExecutionFailed();
    error SlippageExceeded(uint256 actual, uint256 limit);
    error WouldDesyncTenantShares(uint256 remainingShares, uint256 tenantShares);

    // ============ Events ============

    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    // ============ Modifiers ============

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ============ Constructor ============

    /// @param _avatar The M1 Safe address this module is attached to
    /// @param _owner Owner (typically the M1 Safe or admin multisig)
    /// @param _operator Address of the yield manager service backend
    constructor(address _avatar, address _owner, address _operator) Module(_avatar, _avatar, _owner) {
        if (_operator == address(0)) revert InvalidOperator();
        operator = _operator;
        emit OperatorUpdated(address(0), _operator);
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

    // ============ Morpho Operations ============

    /// @notice Deposit USDC into a Morpho vault through the Safe
    /// @param vault The Morpho vault address (must be allowlisted)
    /// @param assets Amount of underlying assets (USDC) to deposit
    /// @param minShares Minimum shares to receive (slippage protection, 0 to skip)
    /// @return shares Amount of vault shares minted to the Safe
    function depositToMorpho(address vault, uint256 assets, uint256 minShares)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        _requireAllowlisted(vault);

        // Step 1: Approve the vault to spend USDC from the Safe
        address underlying = IMorphoVault(vault).asset();
        bytes memory approveData = abi.encodeWithSelector(IERC20.approve.selector, vault, assets);
        bool approveSuccess = exec(underlying, 0, approveData, ISafe.Operation.Call);
        if (!approveSuccess) revert ExecutionFailed();

        // Step 2: Snapshot shares before deposit
        uint256 sharesBefore = IMorphoVault(vault).balanceOf(avatar);

        // Step 3: Deposit into Morpho vault with Safe as receiver
        bytes memory depositData = abi.encodeWithSelector(IMorphoVault.deposit.selector, assets, avatar);
        bool depositSuccess = exec(vault, 0, depositData, ISafe.Operation.Call);
        if (!depositSuccess) revert ExecutionFailed();

        // Step 4: Reset approval to 0 to prevent lingering allowance
        bytes memory resetApproval = abi.encodeWithSelector(IERC20.approve.selector, vault, uint256(0));
        exec(underlying, 0, resetApproval, ISafe.Operation.Call);
        // Don't check return — best effort, some tokens don't support approve(0)

        // Step 5: Compute actual shares minted via balance snapshot
        uint256 sharesAfter = IMorphoVault(vault).balanceOf(avatar);
        shares = sharesAfter - sharesBefore;

        // Step 6: Slippage check
        if (shares < minShares) revert SlippageExceeded(shares, minShares);

        emit MorphoDeposit(vault, assets, shares);
    }

    /// @notice Withdraw USDC from a Morpho vault through the Safe
    /// @param vault The Morpho vault address (must be allowlisted)
    /// @param assets Amount of underlying assets (USDC) to withdraw
    /// @param maxSharesBurned Maximum shares to burn (slippage protection, 0 to skip)
    /// @return sharesBurned Amount of vault shares burned
    function withdrawFromMorpho(address vault, uint256 assets, uint256 maxSharesBurned)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 sharesBurned)
    {
        if (assets == 0) revert ZeroAmount();
        _requireAllowlisted(vault);

        // Snapshot shares before withdrawal
        uint256 sharesBefore = IMorphoVault(vault).balanceOf(avatar);

        // Withdraw from Morpho vault — receiver and owner are both the Safe (avatar)
        bytes memory withdrawData = abi.encodeWithSelector(IMorphoVault.withdraw.selector, assets, avatar, avatar);
        bool success = exec(vault, 0, withdrawData, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        // Compute actual shares burned via balance snapshot
        uint256 sharesAfter = IMorphoVault(vault).balanceOf(avatar);
        sharesBurned = sharesBefore - sharesAfter;
        if (sharesBurned == 0) revert ZeroAmount();

        // Slippage check
        if (maxSharesBurned > 0 && sharesBurned > maxSharesBurned) {
            revert SlippageExceeded(sharesBurned, maxSharesBurned);
        }

        // Cross-module share desync protection
        _checkTenantShareSafety(vault);

        emit MorphoWithdraw(vault, assets, sharesBurned);
    }

    /// @notice Redeem vault shares for USDC from a Morpho vault through the Safe
    /// @param vault The Morpho vault address (must be allowlisted)
    /// @param shares Amount of vault shares to redeem
    /// @param minAssetsOut Minimum assets to receive (slippage protection, 0 to skip)
    /// @return assetsReceived Amount of underlying assets (USDC) received
    function redeemFromMorpho(address vault, uint256 shares, uint256 minAssetsOut)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 assetsReceived)
    {
        if (shares == 0) revert ZeroAmount();
        _requireAllowlisted(vault);

        // Snapshot underlying balance before redemption
        address underlying = IMorphoVault(vault).asset();
        uint256 assetsBefore = IERC20(underlying).balanceOf(avatar);

        // Redeem shares from Morpho vault — receiver and owner are both the Safe (avatar)
        bytes memory redeemData = abi.encodeWithSelector(IMorphoVault.redeem.selector, shares, avatar, avatar);
        bool success = exec(vault, 0, redeemData, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        // Compute actual assets received via balance snapshot
        uint256 assetsAfter = IERC20(underlying).balanceOf(avatar);
        assetsReceived = assetsAfter - assetsBefore;

        // Slippage check
        if (assetsReceived < minAssetsOut) revert SlippageExceeded(assetsReceived, minAssetsOut);

        // Cross-module share desync protection
        _checkTenantShareSafety(vault);

        emit MorphoRedeem(vault, shares, assetsReceived);
    }

    // ============ Aave Operations ============

    /// @notice Supply assets to Aave v3 pool through the Safe
    /// @param pool The Aave v3 pool address (must be allowlisted)
    /// @param asset The ERC20 asset to supply
    /// @param amount Amount to supply
    function supplyToAave(address pool, address asset, uint256 amount)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        _requireAllowlisted(pool);

        // Step 1: Approve the pool to spend the asset from the Safe
        bytes memory approveData = abi.encodeWithSelector(IERC20.approve.selector, pool, amount);
        bool approveSuccess = exec(asset, 0, approveData, ISafe.Operation.Call);
        if (!approveSuccess) revert ExecutionFailed();

        // Step 2: Supply to Aave with Safe (avatar) as the onBehalfOf recipient
        bytes memory supplyData = abi.encodeWithSelector(IAavePool.supply.selector, asset, amount, avatar, uint16(0));
        bool supplySuccess = exec(pool, 0, supplyData, ISafe.Operation.Call);
        if (!supplySuccess) revert ExecutionFailed();

        // Step 3: Reset approval to 0 to prevent lingering allowance
        bytes memory resetApproval = abi.encodeWithSelector(IERC20.approve.selector, pool, uint256(0));
        exec(asset, 0, resetApproval, ISafe.Operation.Call);
        // Don't check return — best effort, some tokens don't support approve(0)

        emit AaveSupply(pool, asset, amount);
    }

    /// @notice Withdraw assets from Aave v3 pool through the Safe
    /// @param pool The Aave v3 pool address (must be allowlisted)
    /// @param asset The ERC20 asset to withdraw
    /// @param amount Amount to withdraw (use type(uint256).max for full balance)
    /// @param minReceived Minimum assets to receive (slippage protection, 0 to skip)
    /// @return withdrawn The actual amount withdrawn
    function withdrawFromAave(address pool, address asset, uint256 amount, uint256 minReceived)
        external
        override
        onlyOperator
        nonReentrant
        whenNotPaused
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();
        _requireAllowlisted(pool);

        // Snapshot balance before withdrawal
        uint256 balanceBefore = IERC20(asset).balanceOf(avatar);

        // Withdraw from Aave with Safe (avatar) as the recipient
        bytes memory withdrawData = abi.encodeWithSelector(IAavePool.withdraw.selector, asset, amount, avatar);
        bool success = exec(pool, 0, withdrawData, ISafe.Operation.Call);
        if (!success) revert ExecutionFailed();

        // Compute actual withdrawn amount via balance snapshot
        uint256 balanceAfter = IERC20(asset).balanceOf(avatar);
        withdrawn = balanceAfter - balanceBefore;

        // Slippage check
        if (withdrawn < minReceived) revert SlippageExceeded(withdrawn, minReceived);

        emit AaveWithdraw(pool, asset, amount, withdrawn);
    }

    // ============ Admin Functions ============

    /// @notice Add a vault/pool address to the allowlist
    /// @param vault The address to allowlist
    function addAllowlistedVault(address vault) external override onlyOwner {
        if (vault == address(0)) revert InvalidVault();
        if (isAllowlistedVault[vault]) revert VaultAlreadyAllowlisted(vault);
        isAllowlistedVault[vault] = true;
        emit VaultAllowlisted(vault);
    }

    /// @notice Remove a vault/pool address from the allowlist
    /// @param vault The address to remove
    function removeAllowlistedVault(address vault) external override onlyOwner {
        if (!isAllowlistedVault[vault]) revert VaultNotFound(vault);
        isAllowlistedVault[vault] = false;
        emit VaultRemoved(vault);
    }

    /// @notice Update the operator (yield manager service) address
    /// @param newOperator The new operator address
    function setOperator(address newOperator) external override onlyOwner {
        if (newOperator == address(0)) revert InvalidOperator();
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /// @notice Set the TreasuryVault address for cross-module share desync protection
    /// @param _treasuryVault The TreasuryVault address (address(0) to disable check)
    function setTreasuryVault(address _treasuryVault) external override onlyOwner {
        treasuryVault = _treasuryVault;
    }

    // ============ Internal Functions ============

    /// @notice Validate that a vault/pool address is allowlisted
    function _requireAllowlisted(address vault) internal view {
        if (!isAllowlistedVault[vault]) revert VaultNotAllowlisted(vault);
    }

    /// @notice Check that remaining vault shares are sufficient to cover TreasuryVault tenant shares
    /// @dev Prevents DeFiInteractor withdrawals from desynchronizing TreasuryVault accounting
    function _checkTenantShareSafety(address vault) internal view {
        if (treasuryVault == address(0)) return;
        if (ITreasuryVault(treasuryVault).morphoVault() != vault) return;
        uint256 remainingShares = IMorphoVault(vault).balanceOf(avatar);
        uint256 tenantShares = ITreasuryVault(treasuryVault).totalTenantShares();
        if (remainingShares < tenantShares) {
            revert WouldDesyncTenantShares(remainingShares, tenantShares);
        }
    }
}
