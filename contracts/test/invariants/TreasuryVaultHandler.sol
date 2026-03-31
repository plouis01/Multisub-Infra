// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TreasuryVault} from "../../src/TreasuryVault.sol";
import {ITreasuryVault} from "../../src/interfaces/ITreasuryVault.sol";
import {MockMorphoVault} from "../mocks/MockMorphoVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSafe} from "../mocks/MockSafe.sol";

/// @notice Handler contract for TreasuryVault invariant (stateful fuzz) tests.
///         Exposes bounded actions that the fuzzer calls in random sequences.
contract TreasuryVaultHandler is Test {
    TreasuryVault public vault;
    MockMorphoVault public morphoVault;
    MockERC20 public usdc;
    MockSafe public safe;

    bytes32[] public tenantIds;

    // Ghost variables for independent tracking
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalShares;

    // Call counters for debugging
    uint256 public calls_deposit;
    uint256 public calls_withdraw;
    uint256 public calls_redeem;

    constructor(TreasuryVault _vault, MockMorphoVault _morphoVault, MockERC20 _usdc, MockSafe _safe) {
        vault = _vault;
        morphoVault = _morphoVault;
        usdc = _usdc;
        safe = _safe;

        // Pre-create tenant IDs (1 through 5)
        for (uint256 i = 1; i <= 5; i++) {
            tenantIds.push(bytes32(uint256(i)));
        }
    }

    /// @notice Deposit USDC for a random tenant with a bounded amount
    function deposit(uint256 tenantSeed, uint256 amount) external {
        bytes32 tenantId = tenantIds[tenantSeed % tenantIds.length];
        amount = bound(amount, 1e6, 1_000_000e6); // 1 USDC to 1M USDC

        // Fund the Safe so it has enough USDC
        usdc.mint(address(safe), amount);

        // Ensure the Morpho vault has enough USDC for future withdrawals
        usdc.mint(address(morphoVault), amount);

        vm.prank(vault.operator());
        uint256 shares = vault.depositForTenant(tenantId, amount, 0);

        ghost_totalDeposited += amount;
        ghost_totalShares += shares;
        calls_deposit++;
    }

    /// @notice Withdraw USDC for a random tenant
    function withdraw(uint256 tenantSeed, uint256 amount) external {
        bytes32 tenantId = tenantIds[tenantSeed % tenantIds.length];
        ITreasuryVault.TenantPosition memory pos = vault.getTenantPosition(tenantId);
        if (pos.shares == 0) return;

        uint256 maxWithdrawable = morphoVault.convertToAssets(pos.shares);
        if (maxWithdrawable == 0) return;
        amount = bound(amount, 1, maxWithdrawable);

        // Ensure Morpho vault has enough USDC to pay out
        uint256 morphoBalance = usdc.balanceOf(address(morphoVault));
        if (morphoBalance < amount) {
            usdc.mint(address(morphoVault), amount - morphoBalance);
        }

        vm.prank(vault.operator());
        try vault.withdrawForTenant(tenantId, amount, 0) returns (uint256 sharesBurned) {
            // Proportional basis reduction (mirrors contract logic)
            uint256 depositReduction = pos.depositedAmount * sharesBurned / pos.shares;
            ghost_totalShares -= sharesBurned;
            ghost_totalDeposited -= depositReduction;
            calls_withdraw++;
        } catch {
            // Revert is acceptable (e.g., rounding edge cases)
        }
    }

    /// @notice Redeem shares for a random tenant
    function redeem(uint256 tenantSeed, uint256 shares) external {
        bytes32 tenantId = tenantIds[tenantSeed % tenantIds.length];
        ITreasuryVault.TenantPosition memory pos = vault.getTenantPosition(tenantId);
        if (pos.shares == 0) return;
        shares = bound(shares, 1, pos.shares);

        // Ensure Morpho vault has enough USDC for the redemption
        uint256 assetsNeeded = morphoVault.convertToAssets(shares);
        uint256 morphoBalance = usdc.balanceOf(address(morphoVault));
        if (morphoBalance < assetsNeeded) {
            usdc.mint(address(morphoVault), assetsNeeded - morphoBalance);
        }

        vm.prank(vault.operator());
        try vault.redeemForTenant(tenantId, shares, 0) {
            // Proportional basis reduction (mirrors contract logic)
            uint256 depositReduction = pos.depositedAmount * shares / pos.shares;
            ghost_totalShares -= shares;
            ghost_totalDeposited -= depositReduction;
            calls_redeem++;
        } catch {
            // Revert is acceptable
        }
    }

    /// @notice Helper to get the number of tenant IDs
    function tenantIdCount() external view returns (uint256) {
        return tenantIds.length;
    }
}
