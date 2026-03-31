// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TreasuryVault} from "../../src/TreasuryVault.sol";
import {ITreasuryVault} from "../../src/interfaces/ITreasuryVault.sol";
import {MockMorphoVault} from "../mocks/MockMorphoVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSafe} from "../mocks/MockSafe.sol";
import {TreasuryVaultHandler} from "./TreasuryVaultHandler.sol";

/// @notice Invariant tests for TreasuryVault.
///         Verifies accounting invariants hold after arbitrary sequences of
///         deposits, withdrawals, and redemptions across multiple tenants.
contract TreasuryVaultInvariantTest is Test {
    TreasuryVaultHandler public handler;
    TreasuryVault public vault;
    MockSafe public safe;
    MockERC20 public usdc;
    MockMorphoVault public morphoVault;

    address public owner = address(0xAA);
    address public operatorEOA = address(0xBB);

    function setUp() public {
        // Deploy mocks
        safe = new MockSafe();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        morphoVault = new MockMorphoVault(address(usdc));

        // Deploy TreasuryVault
        vm.prank(owner);
        vault = new TreasuryVault(address(safe), owner, operatorEOA, address(morphoVault), address(usdc));

        // Enable module on Safe
        safe.enableModule(address(vault));

        // Deploy handler
        handler = new TreasuryVaultHandler(vault, morphoVault, usdc, safe);

        // Target only the handler for fuzzing
        targetContract(address(handler));
    }

    // ============ Invariant 1: totalTenantShares == sum of all tenant shares ============

    function invariant_totalSharesMatchesSum() public view {
        uint256 sum = 0;
        for (uint256 i = 1; i <= 5; i++) {
            sum += vault.getTenantShares(bytes32(uint256(i)));
        }
        assertEq(vault.totalTenantShares(), sum, "totalTenantShares != sum of individual shares");
    }

    // ============ Invariant 2: totalDeposited == sum of all tenant depositedAmounts ============

    function invariant_totalDepositedMatchesSum() public view {
        uint256 sum = 0;
        for (uint256 i = 1; i <= 5; i++) {
            sum += vault.getTenantDeposited(bytes32(uint256(i)));
        }
        assertEq(vault.totalDeposited(), sum, "totalDeposited != sum of individual deposits");
    }

    // ============ Invariant 3: totalTenantShares <= morphoVault.balanceOf(avatar) ============

    function invariant_sharesNotExceedVaultBalance() public view {
        uint256 vaultShares = morphoVault.balanceOf(address(safe));
        assertLe(vault.totalTenantShares(), vaultShares, "totalTenantShares exceeds actual vault share balance");
    }

    // ============ Invariant 4: If shares == 0 then depositedAmount == 0 ============

    function invariant_zeroSharesMeansZeroDeposited() public view {
        for (uint256 i = 1; i <= 5; i++) {
            bytes32 tid = bytes32(uint256(i));
            if (vault.getTenantShares(tid) == 0) {
                assertEq(vault.getTenantDeposited(tid), 0, "Non-zero depositedAmount with zero shares");
            }
        }
    }

    // ============ Invariant 5: Ghost variable cross-check ============

    function invariant_ghostSharesMatchContract() public view {
        assertEq(vault.totalTenantShares(), handler.ghost_totalShares(), "Ghost totalShares diverged from contract");
    }

    function invariant_ghostDepositedMatchContract() public view {
        assertEq(vault.totalDeposited(), handler.ghost_totalDeposited(), "Ghost totalDeposited diverged from contract");
    }

    /// @notice Log call statistics after all invariant runs
    function invariant_callSummary() public view {
        // This invariant always passes; it exists to surface call distribution in -vvv output
        assert(true);
    }
}
