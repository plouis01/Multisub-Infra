// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {ITreasuryVault} from "../src/interfaces/ITreasuryVault.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMorphoVault} from "./mocks/MockMorphoVault.sol";

contract TreasuryVaultTest is Test {
    TreasuryVault public vault;
    MockSafe public safe;
    MockERC20 public usdc;
    MockMorphoVault public morphoVault;

    address public owner = address(0xAA);
    address public operatorEOA = address(0xBB);
    address public attacker = address(0xDD);

    bytes32 public tenantA = keccak256("tenant-A");
    bytes32 public tenantB = keccak256("tenant-B");
    bytes32 public tenantC = keccak256("tenant-C");

    function setUp() public {
        safe = new MockSafe();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        morphoVault = new MockMorphoVault(address(usdc));

        vm.prank(owner);
        vault = new TreasuryVault(address(safe), owner, operatorEOA, address(morphoVault), address(usdc));

        // Enable module on Safe
        safe.enableModule(address(vault));

        // Fund the Safe with USDC
        usdc.mint(address(safe), 1_000_000e6);

        // Fund the Morpho vault with USDC for withdrawals
        usdc.mint(address(morphoVault), 1_000_000e6);
    }

    // ============ Constructor Tests ============

    function test_constructor_setsStateCorrectly() public view {
        assertEq(vault.avatar(), address(safe));
        assertEq(vault.target(), address(safe));
        assertEq(vault.owner(), owner);
        assertEq(vault.operator(), operatorEOA);
        assertEq(vault.morphoVault(), address(morphoVault));
        assertEq(vault.usdc(), address(usdc));
        assertEq(vault.totalTenantShares(), 0);
        assertEq(vault.totalDeposited(), 0);
    }

    function test_constructor_revertsOnZeroAvatar() public {
        vm.expectRevert();
        new TreasuryVault(address(0), owner, operatorEOA, address(morphoVault), address(usdc));
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert();
        new TreasuryVault(address(safe), address(0), operatorEOA, address(morphoVault), address(usdc));
    }

    function test_constructor_revertsOnZeroOperator() public {
        vm.expectRevert(TreasuryVault.InvalidOperator.selector);
        new TreasuryVault(address(safe), owner, address(0), address(morphoVault), address(usdc));
    }

    function test_constructor_revertsOnZeroMorphoVault() public {
        vm.expectRevert(TreasuryVault.InvalidMorphoVault.selector);
        new TreasuryVault(address(safe), owner, operatorEOA, address(0), address(usdc));
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(TreasuryVault.InvalidUsdcAddress.selector);
        new TreasuryVault(address(safe), owner, operatorEOA, address(morphoVault), address(0));
    }

    // ============ Deposit Tests ============

    function test_depositForTenant_depositsAndTracksShares() public {
        uint256 amount = 10_000e6;

        vm.prank(operatorEOA);
        uint256 shares = vault.depositForTenant(tenantA, amount, 0);

        assertGt(shares, 0);
        assertEq(vault.getTenantShares(tenantA), shares);
        assertEq(vault.getTenantDeposited(tenantA), amount);
        assertEq(vault.totalTenantShares(), shares);
        assertEq(vault.totalDeposited(), amount);
    }

    function test_depositForTenant_emitsEvent() public {
        uint256 amount = 5_000e6;
        uint256 expectedShares = morphoVault.convertToShares(amount);

        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.TenantDeposit(tenantA, amount, expectedShares);

        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, amount, 0);
    }

    function test_depositForTenant_multipleDepositsAccumulate() public {
        vm.startPrank(operatorEOA);

        uint256 shares1 = vault.depositForTenant(tenantA, 10_000e6, 0);
        uint256 shares2 = vault.depositForTenant(tenantA, 20_000e6, 0);

        vm.stopPrank();

        assertEq(vault.getTenantShares(tenantA), shares1 + shares2);
        assertEq(vault.getTenantDeposited(tenantA), 30_000e6);
        assertEq(vault.totalDeposited(), 30_000e6);
    }

    function test_depositForTenant_revertsOnZeroAmount() public {
        vm.expectRevert(TreasuryVault.ZeroAmount.selector);
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 0, 0);
    }

    function test_depositForTenant_revertsOnZeroTenantId() public {
        vm.expectRevert(TreasuryVault.ZeroTenantId.selector);
        vm.prank(operatorEOA);
        vault.depositForTenant(bytes32(0), 1000e6, 0);
    }

    function test_depositForTenant_revertsForNonOperator() public {
        vm.expectRevert(TreasuryVault.OnlyOperator.selector);
        vm.prank(attacker);
        vault.depositForTenant(tenantA, 1000e6, 0);
    }

    function test_depositForTenant_revertsForOwner() public {
        vm.expectRevert(TreasuryVault.OnlyOperator.selector);
        vm.prank(owner);
        vault.depositForTenant(tenantA, 1000e6, 0);
    }

    // ============ Withdraw Tests ============

    function test_withdrawForTenant_withdrawsAndUpdatesShares() public {
        // Deposit first
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 50_000e6, 0);

        uint256 sharesBefore = vault.getTenantShares(tenantA);
        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Withdraw half
        vm.prank(operatorEOA);
        uint256 sharesBurned = vault.withdrawForTenant(tenantA, 25_000e6, 0);

        assertGt(sharesBurned, 0);
        assertEq(vault.getTenantShares(tenantA), sharesBefore - sharesBurned);
        assertEq(vault.getTenantDeposited(tenantA), 25_000e6);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + 25_000e6);
    }

    function test_withdrawForTenant_emitsEvent() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        uint256 withdrawAmount = 5_000e6;
        uint256 expectedSharesBurned = morphoVault.convertToShares(withdrawAmount);

        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.TenantWithdraw(tenantA, withdrawAmount, expectedSharesBurned);

        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, withdrawAmount, 0);
    }

    function test_withdrawForTenant_revertsOnInsufficientShares() public {
        // Deposit 10k
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        // Try to withdraw 20k — pre-check catches that estimated shares > tenant's shares
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.InsufficientShares.selector, tenantA, 20_000e6, 10_000e6));
        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 20_000e6, 0);
    }

    function test_withdrawForTenant_revertsOnZeroAmount() public {
        vm.expectRevert(TreasuryVault.ZeroAmount.selector);
        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 0, 0);
    }

    function test_withdrawForTenant_revertsOnZeroTenantId() public {
        vm.expectRevert(TreasuryVault.ZeroTenantId.selector);
        vm.prank(operatorEOA);
        vault.withdrawForTenant(bytes32(0), 1000e6, 0);
    }

    function test_withdrawForTenant_revertsForNonOperator() public {
        vm.expectRevert(TreasuryVault.OnlyOperator.selector);
        vm.prank(attacker);
        vault.withdrawForTenant(tenantA, 1000e6, 0);
    }

    // ============ Per-Tenant Isolation Tests ============

    function test_tenantIsolation_depositsAreSeparate() public {
        vm.startPrank(operatorEOA);

        vault.depositForTenant(tenantA, 100_000e6, 0);
        vault.depositForTenant(tenantB, 50_000e6, 0);
        vault.depositForTenant(tenantC, 25_000e6, 0);

        vm.stopPrank();

        assertEq(vault.getTenantDeposited(tenantA), 100_000e6);
        assertEq(vault.getTenantDeposited(tenantB), 50_000e6);
        assertEq(vault.getTenantDeposited(tenantC), 25_000e6);
        assertEq(vault.totalDeposited(), 175_000e6);

        // Shares should be proportional
        uint256 sharesA = vault.getTenantShares(tenantA);
        uint256 sharesB = vault.getTenantShares(tenantB);
        uint256 sharesC = vault.getTenantShares(tenantC);
        assertEq(sharesA, sharesB * 2); // A deposited 2x B
        assertEq(sharesB, sharesC * 2); // B deposited 2x C
    }

    function test_tenantIsolation_withdrawDoesNotAffectOthers() public {
        vm.startPrank(operatorEOA);

        vault.depositForTenant(tenantA, 100_000e6, 0);
        vault.depositForTenant(tenantB, 50_000e6, 0);

        uint256 sharesBBefore = vault.getTenantShares(tenantB);

        // Withdraw all of tenant A
        vault.withdrawForTenant(tenantA, 100_000e6, 0);

        vm.stopPrank();

        // Tenant A should have nothing
        assertEq(vault.getTenantShares(tenantA), 0);
        assertEq(vault.getTenantDeposited(tenantA), 0);

        // Tenant B should be unaffected
        assertEq(vault.getTenantShares(tenantB), sharesBBefore);
        assertEq(vault.getTenantDeposited(tenantB), 50_000e6);
    }

    // ============ Yield Calculation Tests ============

    function test_getYieldForTenant_returnsZeroInitially() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        // At 1:1 exchange rate, yield should be 0
        uint256 yield_ = vault.getYieldForTenant(tenantA);
        assertEq(yield_, 0);
    }

    function test_getYieldForTenant_returnsZeroForNoDeposit() public view {
        uint256 yield_ = vault.getYieldForTenant(tenantA);
        assertEq(yield_, 0);
    }

    function test_getYieldForTenant_calculatesYieldAfterRateIncrease() public {
        // Deposit 100k at 1:1 rate
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate 5% yield by changing exchange rate
        morphoVault.setExchangeRate(1_050_000); // 1.05x

        uint256 yield_ = vault.getYieldForTenant(tenantA);
        // shares = 100_000e6 (at 1:1), after 1.05x rate: value = 105_000e6
        // yield = 105_000e6 - 100_000e6 = 5_000e6
        assertEq(yield_, 5_000e6);
    }

    function test_getYieldForTenant_isolatesYieldPerTenant() public {
        vm.startPrank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);
        vault.depositForTenant(tenantB, 200_000e6, 0);
        vm.stopPrank();

        // Simulate 10% yield
        morphoVault.setExchangeRate(1_100_000); // 1.10x

        uint256 yieldA = vault.getYieldForTenant(tenantA);
        uint256 yieldB = vault.getYieldForTenant(tenantB);

        // Tenant A: 100k * 1.1 - 100k = 10k
        assertEq(yieldA, 10_000e6);
        // Tenant B: 200k * 1.1 - 200k = 20k
        assertEq(yieldB, 20_000e6);
    }

    // ============ Yield Snapshot Tests ============

    function test_snapshotYield_recordsYieldForTenants() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate yield
        morphoVault.setExchangeRate(1_030_000); // 3% yield

        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA;

        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);

        ITreasuryVault.TenantPosition memory pos = vault.getTenantPosition(tenantA);
        assertEq(pos.lastSnapshotYield, 3_000e6);
        assertEq(pos.lastSnapshotTime, block.timestamp);
    }

    function test_snapshotYield_emitsEvents() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        morphoVault.setExchangeRate(1_050_000); // 5% yield

        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA;

        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.YieldSnapshot(tenantA, 5_000e6, block.timestamp);

        vm.expectEmit(false, false, false, true);
        emit ITreasuryVault.GlobalYieldSnapshot(1, block.timestamp);

        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);
    }

    function test_snapshotYield_multipleTenants() public {
        vm.startPrank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);
        vault.depositForTenant(tenantB, 50_000e6, 0);
        vm.stopPrank();

        morphoVault.setExchangeRate(1_020_000); // 2% yield

        bytes32[] memory tenantIds = new bytes32[](2);
        tenantIds[0] = tenantA;
        tenantIds[1] = tenantB;

        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);

        ITreasuryVault.TenantPosition memory posA = vault.getTenantPosition(tenantA);
        ITreasuryVault.TenantPosition memory posB = vault.getTenantPosition(tenantB);

        assertEq(posA.lastSnapshotYield, 2_000e6); // 2% of 100k
        assertEq(posB.lastSnapshotYield, 1_000e6); // 2% of 50k
    }

    function test_snapshotYield_skipsTenantWithNoShares() public {
        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA; // Has no deposits

        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);

        ITreasuryVault.TenantPosition memory pos = vault.getTenantPosition(tenantA);
        assertEq(pos.lastSnapshotYield, 0);
        assertEq(pos.lastSnapshotTime, 0);
    }

    function test_snapshotYield_callableByOwner() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA;

        // Owner can also snapshot
        vm.prank(owner);
        vault.snapshotYield(tenantIds);
    }

    function test_snapshotYield_revertsForNonOperatorOrOwner() public {
        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA;

        vm.expectRevert(TreasuryVault.OnlyOperatorOrOwner.selector);
        vm.prank(attacker);
        vault.snapshotYield(tenantIds);
    }

    // ============ Admin Functions Tests ============

    function test_setOperator_updatesOperator() public {
        address newOperator = address(0xEE);
        vm.prank(owner);
        vault.setOperator(newOperator);
        assertEq(vault.operator(), newOperator);
    }

    function test_setOperator_emitsEvent() public {
        address newOperator = address(0xEE);
        vm.expectEmit(true, true, false, false);
        emit ITreasuryVault.OperatorUpdated(operatorEOA, newOperator);
        vm.prank(owner);
        vault.setOperator(newOperator);
    }

    function test_setOperator_revertsOnZero() public {
        vm.expectRevert(TreasuryVault.InvalidOperator.selector);
        vm.prank(owner);
        vault.setOperator(address(0));
    }

    function test_setOperator_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.setOperator(address(0xEE));
    }

    function test_setMorphoVault_updatesVault() public {
        address newVault = address(0xFF);
        vm.prank(owner);
        vault.setMorphoVault(newVault);
        assertEq(vault.morphoVault(), newVault);
    }

    function test_setMorphoVault_emitsEvent() public {
        address newVault = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ITreasuryVault.MorphoVaultUpdated(address(morphoVault), newVault);
        vm.prank(owner);
        vault.setMorphoVault(newVault);
    }

    function test_setMorphoVault_revertsOnZero() public {
        vm.expectRevert(TreasuryVault.InvalidMorphoVault.selector);
        vm.prank(owner);
        vault.setMorphoVault(address(0));
    }

    function test_setMorphoVault_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.setMorphoVault(address(0xFF));
    }

    // ============ Pause Tests ============

    function test_pause_preventsDeposit() public {
        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 1000e6, 0);
    }

    function test_pause_preventsWithdraw() public {
        // Deposit first
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 5_000e6, 0);
    }

    function test_pause_preventsSnapshot() public {
        vm.prank(owner);
        vault.pause();

        bytes32[] memory tenantIds = new bytes32[](1);
        tenantIds[0] = tenantA;

        vm.expectRevert();
        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);
    }

    function test_unpause_allowsOperations() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        vault.unpause();

        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 1000e6, 0);
        assertEq(vault.getTenantDeposited(tenantA), 1000e6);
    }

    function test_pause_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        vault.pause();
    }

    // ============ Edge Cases ============

    function test_withdrawAll_clearsTenantPosition() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 50_000e6, 0);

        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 50_000e6, 0);

        assertEq(vault.getTenantShares(tenantA), 0);
        assertEq(vault.getTenantDeposited(tenantA), 0);
        assertEq(vault.getYieldForTenant(tenantA), 0);
    }

    function test_moduleDisabled_revertsOnDeposit() public {
        safe.disableModule(address(0), address(vault));

        vm.expectRevert(TreasuryVault.ExecutionFailed.selector);
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 1000e6, 0);
    }

    function test_depositAndWithdrawWithYield() public {
        // Deposit 100k
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate 5% yield
        morphoVault.setExchangeRate(1_050_000);

        // Check yield before withdraw
        uint256 yieldBefore = vault.getYieldForTenant(tenantA);
        assertEq(yieldBefore, 5_000e6);

        // Withdraw 50k
        vm.prank(operatorEOA);
        uint256 sharesBurned = vault.withdrawForTenant(tenantA, 50_000e6, 0);

        // Proportional basis reduction — deposited reduced proportional to shares burned
        uint256 expectedDepositReduction = 100_000e6 * sharesBurned / (vault.getTenantShares(tenantA) + sharesBurned);
        assertEq(vault.getTenantDeposited(tenantA), 100_000e6 - expectedDepositReduction);

        // Remaining shares should still reflect yield on remaining position
        uint256 remainingShares = vault.getTenantShares(tenantA);
        assertGt(remainingShares, 0);
    }

    // ============ Ownership Transfer ============

    function test_transferOwnership() public {
        address newOwner = address(0x99);
        vm.prank(owner);
        vault.transferOwnership(newOwner);

        // Owner has not changed yet (two-step)
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), newOwner);

        // New owner accepts ownership
        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
        assertEq(vault.pendingOwner(), address(0));

        // Old owner cannot configure
        vm.expectRevert();
        vm.prank(owner);
        vault.setOperator(address(0xEE));

        // New owner can
        vm.prank(newOwner);
        vault.setOperator(address(0xEE));
        assertEq(vault.operator(), address(0xEE));
    }

    // ============ View Function Tests ============

    function test_getTenantPosition_returnsFullStruct() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        ITreasuryVault.TenantPosition memory pos = vault.getTenantPosition(tenantA);
        assertGt(pos.shares, 0);
        assertEq(pos.depositedAmount, 10_000e6);
        assertEq(pos.lastSnapshotYield, 0);
        assertEq(pos.lastSnapshotTime, 0);
    }

    // ============ Fuzz Tests ============

    function testFuzz_depositForTenant_arbitraryAmounts(uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1_000_000e6);

        vm.prank(operatorEOA);
        uint256 shares = vault.depositForTenant(tenantA, uint256(amount), 0);

        assertGt(shares, 0);
        assertEq(vault.getTenantDeposited(tenantA), amount);
        assertEq(vault.totalDeposited(), amount);
    }

    function testFuzz_yieldCalculation_variousRates(uint32 rateIncrease) public {
        vm.assume(rateIncrease > 0);
        vm.assume(rateIncrease <= 500_000); // Max 50% yield

        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        uint256 newRate = 1_000_000 + uint256(rateIncrease);
        morphoVault.setExchangeRate(newRate);

        uint256 yield_ = vault.getYieldForTenant(tenantA);
        assertGt(yield_, 0);
    }

    function testFuzz_depositAndWithdraw_tenantIsolation(uint128 amountA, uint128 amountB) public {
        vm.assume(amountA > 0 && amountA <= 500_000e6);
        vm.assume(amountB > 0 && amountB <= 500_000e6);

        vm.startPrank(operatorEOA);
        vault.depositForTenant(tenantA, uint256(amountA), 0);
        vault.depositForTenant(tenantB, uint256(amountB), 0);
        vm.stopPrank();

        assertEq(vault.getTenantDeposited(tenantA), amountA);
        assertEq(vault.getTenantDeposited(tenantB), amountB);
        assertEq(vault.totalDeposited(), uint256(amountA) + uint256(amountB));
    }

    // ============ Before/After Share Snapshot Tests ============

    function test_depositForTenant_usesBalanceSnapshot() public {
        // Verify shares are measured via before/after balanceOf, not convertToShares
        uint256 amount = 10_000e6;

        // At 1:1 rate, both methods should agree
        vm.prank(operatorEOA);
        uint256 shares = vault.depositForTenant(tenantA, amount, 0);

        // The actual shares in the morpho vault for the safe should match tracked shares
        assertEq(morphoVault.balanceOf(address(safe)), vault.totalTenantShares());
        assertEq(shares, morphoVault.balanceOf(address(safe)));
    }

    function test_withdrawForTenant_usesBalanceSnapshot() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 50_000e6, 0);

        uint256 morphoSharesBefore = morphoVault.balanceOf(address(safe));

        vm.prank(operatorEOA);
        uint256 sharesBurned = vault.withdrawForTenant(tenantA, 25_000e6, 0);

        uint256 morphoSharesAfter = morphoVault.balanceOf(address(safe));
        // The reported sharesBurned should match the actual change in morpho vault balance
        assertEq(sharesBurned, morphoSharesBefore - morphoSharesAfter);
    }

    // ============ MAX_SNAPSHOT_BATCH Tests ============

    function test_snapshotYield_revertsOnBatchTooLarge() public {
        bytes32[] memory tenantIds = new bytes32[](101);
        for (uint256 i = 0; i < 101; i++) {
            tenantIds[i] = keccak256(abi.encodePacked("tenant", i));
        }

        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.BatchTooLarge.selector, 101, 100));
        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);
    }

    function test_snapshotYield_allowsMaxBatchSize() public {
        bytes32[] memory tenantIds = new bytes32[](100);
        for (uint256 i = 0; i < 100; i++) {
            tenantIds[i] = keccak256(abi.encodePacked("tenant", i));
        }

        // Should not revert (no deposits, so snapshots are skipped but batch size is valid)
        vm.prank(operatorEOA);
        vault.snapshotYield(tenantIds);
    }

    function test_MAX_SNAPSHOT_BATCH_isPublic() public view {
        assertEq(vault.MAX_SNAPSHOT_BATCH(), 100);
    }

    // ============ Vault Migration Blocked With Positions ============

    function test_setMorphoVault_revertsWhenPositionsExist() public {
        // Deposit to create positions
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        uint256 totalShares = vault.totalTenantShares();
        assertGt(totalShares, 0);

        // Attempt migration should fail
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.PositionsExist.selector, totalShares));
        vm.prank(owner);
        vault.setMorphoVault(address(0xFF));
    }

    function test_setMorphoVault_allowsWhenNoPositions() public {
        // No deposits, so migration should succeed
        assertEq(vault.totalTenantShares(), 0);

        address newVault = address(0xFF);
        vm.prank(owner);
        vault.setMorphoVault(newVault);
        assertEq(vault.morphoVault(), newVault);
    }

    function test_setMorphoVault_allowsAfterFullWithdrawal() public {
        // Deposit then fully withdraw
        vm.startPrank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);
        vault.withdrawForTenant(tenantA, 10_000e6, 0);
        vm.stopPrank();

        assertEq(vault.totalTenantShares(), 0);

        // Migration should now succeed
        address newVault = address(0xFF);
        vm.prank(owner);
        vault.setMorphoVault(newVault);
        assertEq(vault.morphoVault(), newVault);
    }

    // ============ Fix M-10: redeemForTenant Tests ============

    function test_redeemForTenant_redeemsByShareCount() public {
        // Deposit 100k at 1:1 rate
        vm.prank(operatorEOA);
        uint256 depositShares = vault.depositForTenant(tenantA, 100_000e6, 0);

        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Redeem half the shares
        uint256 redeemShares = depositShares / 2;
        vm.prank(operatorEOA);
        uint256 assetsReceived = vault.redeemForTenant(tenantA, redeemShares, 0);

        // At 1:1 rate, assets should equal shares
        assertEq(assetsReceived, 50_000e6);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + assetsReceived);
        assertEq(vault.getTenantShares(tenantA), depositShares - redeemShares);
        assertEq(vault.getTenantDeposited(tenantA), 50_000e6);
    }

    function test_redeemForTenant_worksInLossScenario() public {
        // Deposit 100k at 1:1 rate
        vm.prank(operatorEOA);
        uint256 depositShares = vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate 10% loss
        morphoVault.setExchangeRate(900_000); // 0.9x

        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Redeem all shares — should get back 90k (10% loss)
        vm.prank(operatorEOA);
        uint256 assetsReceived = vault.redeemForTenant(tenantA, depositShares, 0);

        // At 0.9x rate, assets = shares * 0.9
        assertEq(assetsReceived, 90_000e6);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + assetsReceived);
        assertEq(vault.getTenantShares(tenantA), 0);
        // proportional basis reduction — all shares redeemed, deposited zeroed out
        assertEq(vault.getTenantDeposited(tenantA), 0);
    }

    function test_redeemForTenant_emitsEvent() public {
        vm.prank(operatorEOA);
        uint256 depositShares = vault.depositForTenant(tenantA, 10_000e6, 0);

        uint256 redeemShares = depositShares / 2;
        uint256 expectedAssets = morphoVault.convertToAssets(redeemShares);

        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.TenantWithdraw(tenantA, expectedAssets, redeemShares);

        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, redeemShares, 0);
    }

    function test_redeemForTenant_revertsOnInsufficientShares() public {
        vm.prank(operatorEOA);
        uint256 depositShares = vault.depositForTenant(tenantA, 10_000e6, 0);

        uint256 tooManyShares = depositShares + 1;
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryVault.InsufficientShares.selector, tenantA, tooManyShares, depositShares)
        );
        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, tooManyShares, 0);
    }

    function test_redeemForTenant_revertsOnZeroShares() public {
        vm.expectRevert(TreasuryVault.ZeroAmount.selector);
        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, 0, 0);
    }

    function test_redeemForTenant_revertsOnZeroTenantId() public {
        vm.expectRevert(TreasuryVault.ZeroTenantId.selector);
        vm.prank(operatorEOA);
        vault.redeemForTenant(bytes32(0), 1000, 0);
    }

    function test_redeemForTenant_revertsForNonOperator() public {
        vm.expectRevert(TreasuryVault.OnlyOperator.selector);
        vm.prank(attacker);
        vault.redeemForTenant(tenantA, 1000, 0);
    }

    function test_redeemForTenant_updatesTotals() public {
        vm.startPrank(operatorEOA);
        uint256 sharesA = vault.depositForTenant(tenantA, 100_000e6, 0);
        vault.depositForTenant(tenantB, 50_000e6, 0);
        vm.stopPrank();

        uint256 totalSharesBefore = vault.totalTenantShares();
        uint256 totalDepositedBefore = vault.totalDeposited();

        vm.prank(operatorEOA);
        uint256 assetsReceived = vault.redeemForTenant(tenantA, sharesA, 0);

        assertEq(vault.totalTenantShares(), totalSharesBefore - sharesA);
        assertEq(vault.totalDeposited(), totalDepositedBefore - assetsReceived);
    }

    function test_redeemForTenant_pausePreventsRedeem() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 10_000e6, 0);

        vm.prank(owner);
        vault.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, 1000, 0);
    }

    // ============ Zero-Share Deposit Tests ============

    function test_depositForTenant_revertsOnZeroShares() public {
        // Create a mock vault that would return 0 shares for a deposit
        // This scenario can occur with rounding at extreme exchange rates
        // Set exchange rate very high so shares round to 0 for small deposits
        morphoVault.setExchangeRate(type(uint128).max);

        vm.expectRevert(TreasuryVault.ZeroSharesMinted.selector);
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 1, 0); // tiny amount that rounds to 0 shares
    }

    // ============ Slippage Protection Tests ============

    function test_depositForTenant_revertsOnSlippage() public {
        uint256 amount = 10_000e6;
        // At 1:1 rate, shares == amount. Set minShares higher than possible.
        uint256 impossibleMinShares = amount + 1;

        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.SlippageExceeded.selector, amount, impossibleMinShares));
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, amount, impossibleMinShares);
    }

    function test_withdrawForTenant_revertsOnSlippage() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 50_000e6, 0);

        // At 1:1 rate, withdrawing 10k burns 10k shares. Set maxSharesBurned to 1.
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.SlippageExceeded.selector, 10_000e6, 1));
        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 10_000e6, 1);
    }

    function test_redeemForTenant_revertsOnSlippage() public {
        vm.prank(operatorEOA);
        uint256 shares = vault.depositForTenant(tenantA, 10_000e6, 0);

        // At 1:1, redeeming shares gives 10k. Set minAssetsOut higher.
        uint256 impossibleMinAssets = 10_001e6;
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.SlippageExceeded.selector, 10_000e6, impossibleMinAssets));
        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, shares, impossibleMinAssets);
    }

    // ============ Proportional Basis Reduction Tests ============

    function test_withdrawForTenant_proportionalBasisReduction() public {
        // Deposit 100k at 1:1
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate 10% yield
        morphoVault.setExchangeRate(1_100_000); // 1.1x

        uint256 sharesBefore = vault.getTenantShares(tenantA);
        uint256 depositedBefore = vault.getTenantDeposited(tenantA);

        // Withdraw 55k (half the current value of 110k)
        vm.prank(operatorEOA);
        uint256 sharesBurned = vault.withdrawForTenant(tenantA, 55_000e6, 0);

        // Proportional deposit reduction: depositedBefore * sharesBurned / sharesBefore
        uint256 expectedReduction = depositedBefore * sharesBurned / sharesBefore;
        uint256 expectedRemaining = depositedBefore - expectedReduction;

        assertEq(vault.getTenantDeposited(tenantA), expectedRemaining);
        // The deposit reduction is proportional to shares burned, not to USDC withdrawn
        assertTrue(expectedReduction != 55_000e6); // NOT equal to withdrawal amount
    }

    function test_redeemForTenant_proportionalBasisReduction() public {
        // Deposit 100k at 1:1
        vm.prank(operatorEOA);
        uint256 totalShares = vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate 10% yield
        morphoVault.setExchangeRate(1_100_000);

        // Redeem half shares
        uint256 halfShares = totalShares / 2;
        vm.prank(operatorEOA);
        vault.redeemForTenant(tenantA, halfShares, 0);

        // Proportional: depositedAmount reduced by 50% (half shares redeemed)
        assertEq(vault.getTenantDeposited(tenantA), 50_000e6);
    }

    function test_withdrawForTenant_fullWithdrawalZerosDeposited() public {
        vm.prank(operatorEOA);
        vault.depositForTenant(tenantA, 100_000e6, 0);

        // Simulate yield by increasing totalAssets (which also adjusts exchange rate)
        morphoVault.simulateYield(10_000e6);

        // Withdraw all (110k at 1.1x)
        vm.prank(operatorEOA);
        vault.withdrawForTenant(tenantA, 110_000e6, 0);

        // All shares gone, deposited zeroed
        assertEq(vault.getTenantShares(tenantA), 0);
        assertEq(vault.getTenantDeposited(tenantA), 0);
    }
}
