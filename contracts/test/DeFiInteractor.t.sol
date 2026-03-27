// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";
import {IDeFiInteractor} from "../src/interfaces/IDeFiInteractor.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockMorphoVault} from "./mocks/MockMorphoVault.sol";
import {MockAavePool} from "./mocks/MockAavePool.sol";

contract DeFiInteractorTest is Test {
    DeFiInteractor public interactor;
    MockSafe public safe;
    MockERC20 public usdc;
    MockMorphoVault public morphoVault;
    MockAavePool public aavePool;
    MockERC20 public aUsdc; // mock aToken

    address public owner = address(0xAA);
    address public operatorEOA = address(0xBB);
    address public attacker = address(0xDD);

    function setUp() public {
        safe = new MockSafe();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        morphoVault = new MockMorphoVault(address(usdc));
        aavePool = new MockAavePool();
        aUsdc = new MockERC20("Aave USDC", "aUSDC", 6);

        // Configure aToken for the pool
        aavePool.setAToken(address(usdc), address(aUsdc));

        vm.prank(owner);
        interactor = new DeFiInteractor(address(safe), owner, operatorEOA);

        // Enable module on Safe
        safe.enableModule(address(interactor));

        // Allowlist the Morpho vault and Aave pool
        vm.startPrank(owner);
        interactor.addAllowlistedVault(address(morphoVault));
        interactor.addAllowlistedVault(address(aavePool));
        vm.stopPrank();

        // Fund the Safe with USDC
        usdc.mint(address(safe), 1_000_000e6);

        // Fund the Morpho vault with USDC for withdrawals
        usdc.mint(address(morphoVault), 1_000_000e6);

        // Fund the Aave pool with USDC for withdrawals
        usdc.mint(address(aavePool), 1_000_000e6);
    }

    // ============ Constructor Tests ============

    function test_constructor_setsStateCorrectly() public view {
        assertEq(interactor.avatar(), address(safe));
        assertEq(interactor.target(), address(safe));
        assertEq(interactor.owner(), owner);
        assertEq(interactor.operator(), operatorEOA);
    }

    function test_constructor_revertsOnZeroAvatar() public {
        vm.expectRevert();
        new DeFiInteractor(address(0), owner, operatorEOA);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert();
        new DeFiInteractor(address(safe), address(0), operatorEOA);
    }

    function test_constructor_revertsOnZeroOperator() public {
        vm.expectRevert(DeFiInteractor.InvalidOperator.selector);
        new DeFiInteractor(address(safe), owner, address(0));
    }

    // ============ Allowlist Management Tests ============

    function test_addAllowlistedVault_addsVault() public {
        address newVault = address(0x123);
        vm.prank(owner);
        interactor.addAllowlistedVault(newVault);
        assertTrue(interactor.isAllowlistedVault(newVault));
    }

    function test_addAllowlistedVault_emitsEvent() public {
        address newVault = address(0x123);
        vm.expectEmit(true, false, false, false);
        emit IDeFiInteractor.VaultAllowlisted(newVault);
        vm.prank(owner);
        interactor.addAllowlistedVault(newVault);
    }

    function test_addAllowlistedVault_revertsOnZero() public {
        vm.expectRevert(DeFiInteractor.InvalidVault.selector);
        vm.prank(owner);
        interactor.addAllowlistedVault(address(0));
    }

    function test_addAllowlistedVault_revertsOnDuplicate() public {
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultAlreadyAllowlisted.selector, address(morphoVault)));
        vm.prank(owner);
        interactor.addAllowlistedVault(address(morphoVault));
    }

    function test_addAllowlistedVault_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        interactor.addAllowlistedVault(address(0x123));
    }

    function test_removeAllowlistedVault_removesVault() public {
        vm.prank(owner);
        interactor.removeAllowlistedVault(address(morphoVault));
        assertFalse(interactor.isAllowlistedVault(address(morphoVault)));
    }

    function test_removeAllowlistedVault_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit IDeFiInteractor.VaultRemoved(address(morphoVault));
        vm.prank(owner);
        interactor.removeAllowlistedVault(address(morphoVault));
    }

    function test_removeAllowlistedVault_revertsIfNotFound() public {
        address unknownVault = address(0x999);
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotFound.selector, unknownVault));
        vm.prank(owner);
        interactor.removeAllowlistedVault(unknownVault);
    }

    function test_removeAllowlistedVault_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        interactor.removeAllowlistedVault(address(morphoVault));
    }

    // ============ Morpho Deposit Tests ============

    function test_depositToMorpho_depositsUSDC() public {
        uint256 amount = 10_000e6;

        vm.prank(operatorEOA);
        uint256 shares = interactor.depositToMorpho(address(morphoVault), amount);

        assertGt(shares, 0);
        // Safe should have less USDC
        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - amount);
        // Morpho vault should have the Safe's shares
        assertEq(morphoVault.balanceOf(address(safe)), shares);
    }

    function test_depositToMorpho_emitsEvent() public {
        uint256 amount = 5_000e6;
        uint256 expectedShares = morphoVault.convertToShares(amount);

        vm.expectEmit(true, false, false, true);
        emit IDeFiInteractor.MorphoDeposit(address(morphoVault), amount, expectedShares);

        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), amount);
    }

    function test_depositToMorpho_revertsOnZeroAmount() public {
        vm.expectRevert(DeFiInteractor.ZeroAmount.selector);
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 0);
    }

    function test_depositToMorpho_revertsOnNonAllowlistedVault() public {
        address fakeVault = address(0x999);
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotAllowlisted.selector, fakeVault));
        vm.prank(operatorEOA);
        interactor.depositToMorpho(fakeVault, 1000e6);
    }

    function test_depositToMorpho_revertsForNonOperator() public {
        vm.expectRevert(DeFiInteractor.OnlyOperator.selector);
        vm.prank(attacker);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    function test_depositToMorpho_revertsForOwner() public {
        vm.expectRevert(DeFiInteractor.OnlyOperator.selector);
        vm.prank(owner);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    // ============ Morpho Withdraw Tests ============

    function test_withdrawFromMorpho_withdrawsUSDC() public {
        // First deposit
        uint256 depositAmount = 50_000e6;
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), depositAmount);

        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Withdraw half
        uint256 withdrawAmount = 25_000e6;
        vm.prank(operatorEOA);
        uint256 sharesBurned = interactor.withdrawFromMorpho(address(morphoVault), withdrawAmount);

        assertGt(sharesBurned, 0);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + withdrawAmount);
    }

    function test_withdrawFromMorpho_emitsEvent() public {
        // Deposit first
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 10_000e6);

        uint256 withdrawAmount = 5_000e6;
        uint256 expectedShares = morphoVault.convertToShares(withdrawAmount);

        vm.expectEmit(true, false, false, true);
        emit IDeFiInteractor.MorphoWithdraw(address(morphoVault), withdrawAmount, expectedShares);

        vm.prank(operatorEOA);
        interactor.withdrawFromMorpho(address(morphoVault), withdrawAmount);
    }

    function test_withdrawFromMorpho_revertsOnZeroAmount() public {
        vm.expectRevert(DeFiInteractor.ZeroAmount.selector);
        vm.prank(operatorEOA);
        interactor.withdrawFromMorpho(address(morphoVault), 0);
    }

    function test_withdrawFromMorpho_revertsOnNonAllowlisted() public {
        address fakeVault = address(0x999);
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotAllowlisted.selector, fakeVault));
        vm.prank(operatorEOA);
        interactor.withdrawFromMorpho(fakeVault, 1000e6);
    }

    // ============ Morpho Redeem Tests ============

    function test_redeemFromMorpho_redeemsShares() public {
        // Deposit first
        uint256 depositAmount = 20_000e6;
        vm.prank(operatorEOA);
        uint256 depositedShares = interactor.depositToMorpho(address(morphoVault), depositAmount);

        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Redeem half the shares
        uint256 sharesToRedeem = depositedShares / 2;
        vm.prank(operatorEOA);
        uint256 assetsReceived = interactor.redeemFromMorpho(address(morphoVault), sharesToRedeem);

        assertGt(assetsReceived, 0);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + assetsReceived);
    }

    function test_redeemFromMorpho_emitsEvent() public {
        // Deposit first
        vm.prank(operatorEOA);
        uint256 shares = interactor.depositToMorpho(address(morphoVault), 10_000e6);

        uint256 expectedAssets = morphoVault.convertToAssets(shares);

        vm.expectEmit(true, false, false, true);
        emit IDeFiInteractor.MorphoRedeem(address(morphoVault), shares, expectedAssets);

        vm.prank(operatorEOA);
        interactor.redeemFromMorpho(address(morphoVault), shares);
    }

    function test_redeemFromMorpho_revertsOnZeroShares() public {
        vm.expectRevert(DeFiInteractor.ZeroAmount.selector);
        vm.prank(operatorEOA);
        interactor.redeemFromMorpho(address(morphoVault), 0);
    }

    // ============ Aave Supply Tests ============

    function test_supplyToAave_suppliesUSDC() public {
        uint256 amount = 10_000e6;

        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), amount);

        // Safe should have less USDC
        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - amount);
        // Pool should track the deposit
        assertEq(aavePool.deposits(address(safe), address(usdc)), amount);
    }

    function test_supplyToAave_emitsEvent() public {
        uint256 amount = 5_000e6;

        vm.expectEmit(true, true, false, true);
        emit IDeFiInteractor.AaveSupply(address(aavePool), address(usdc), amount);

        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), amount);
    }

    function test_supplyToAave_revertsOnZeroAmount() public {
        vm.expectRevert(DeFiInteractor.ZeroAmount.selector);
        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), 0);
    }

    function test_supplyToAave_revertsOnNonAllowlisted() public {
        address fakePool = address(0x999);
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotAllowlisted.selector, fakePool));
        vm.prank(operatorEOA);
        interactor.supplyToAave(fakePool, address(usdc), 1000e6);
    }

    function test_supplyToAave_revertsForNonOperator() public {
        vm.expectRevert(DeFiInteractor.OnlyOperator.selector);
        vm.prank(attacker);
        interactor.supplyToAave(address(aavePool), address(usdc), 1000e6);
    }

    // ============ Aave Withdraw Tests ============

    function test_withdrawFromAave_withdrawsUSDC() public {
        // Supply first
        uint256 supplyAmount = 20_000e6;
        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), supplyAmount);

        uint256 safeBalanceBefore = usdc.balanceOf(address(safe));

        // Withdraw half
        uint256 withdrawAmount = 10_000e6;
        vm.prank(operatorEOA);
        uint256 withdrawn = interactor.withdrawFromAave(address(aavePool), address(usdc), withdrawAmount);

        assertEq(withdrawn, withdrawAmount);
        assertEq(usdc.balanceOf(address(safe)), safeBalanceBefore + withdrawAmount);
    }

    function test_withdrawFromAave_emitsEvent() public {
        // Supply first
        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), 10_000e6);

        uint256 withdrawAmount = 5_000e6;

        vm.expectEmit(true, true, false, true);
        emit IDeFiInteractor.AaveWithdraw(address(aavePool), address(usdc), withdrawAmount, withdrawAmount);

        vm.prank(operatorEOA);
        interactor.withdrawFromAave(address(aavePool), address(usdc), withdrawAmount);
    }

    function test_withdrawFromAave_revertsOnZeroAmount() public {
        vm.expectRevert(DeFiInteractor.ZeroAmount.selector);
        vm.prank(operatorEOA);
        interactor.withdrawFromAave(address(aavePool), address(usdc), 0);
    }

    function test_withdrawFromAave_revertsOnNonAllowlisted() public {
        address fakePool = address(0x999);
        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotAllowlisted.selector, fakePool));
        vm.prank(operatorEOA);
        interactor.withdrawFromAave(fakePool, address(usdc), 1000e6);
    }

    // ============ Operator Management Tests ============

    function test_setOperator_updatesOperator() public {
        address newOperator = address(0xEE);
        vm.prank(owner);
        interactor.setOperator(newOperator);
        assertEq(interactor.operator(), newOperator);
    }

    function test_setOperator_emitsEvent() public {
        address newOperator = address(0xEE);
        vm.expectEmit(true, true, false, false);
        emit IDeFiInteractor.OperatorUpdated(operatorEOA, newOperator);
        vm.prank(owner);
        interactor.setOperator(newOperator);
    }

    function test_setOperator_revertsOnZero() public {
        vm.expectRevert(DeFiInteractor.InvalidOperator.selector);
        vm.prank(owner);
        interactor.setOperator(address(0));
    }

    function test_setOperator_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        interactor.setOperator(address(0xEE));
    }

    function test_setOperator_newOperatorCanExecute() public {
        address newOperator = address(0xEE);
        vm.prank(owner);
        interactor.setOperator(newOperator);

        // New operator can deposit
        vm.prank(newOperator);
        interactor.depositToMorpho(address(morphoVault), 1000e6);

        // Old operator cannot
        vm.expectRevert(DeFiInteractor.OnlyOperator.selector);
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    // ============ Pause Tests ============

    function test_pause_preventsDeposit() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    function test_pause_preventsWithdraw() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        interactor.withdrawFromMorpho(address(morphoVault), 1000e6);
    }

    function test_pause_preventsRedeem() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        interactor.redeemFromMorpho(address(morphoVault), 1000e6);
    }

    function test_pause_preventsAaveSupply() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), 1000e6);
    }

    function test_pause_preventsAaveWithdraw() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(operatorEOA);
        interactor.withdrawFromAave(address(aavePool), address(usdc), 1000e6);
    }

    function test_unpause_allowsOperations() public {
        vm.prank(owner);
        interactor.pause();

        vm.prank(owner);
        interactor.unpause();

        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - 1000e6);
    }

    function test_pause_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        interactor.pause();
    }

    function test_unpause_onlyOwner() public {
        vm.prank(owner);
        interactor.pause();

        vm.expectRevert();
        vm.prank(attacker);
        interactor.unpause();
    }

    // ============ Module Disabled Test ============

    function test_depositToMorpho_revertsWhenModuleDisabled() public {
        safe.disableModule(address(0), address(interactor));

        vm.expectRevert(DeFiInteractor.ExecutionFailed.selector);
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    // ============ Multiple Operations Test ============

    function test_multipleDepositsAndWithdrawals() public {
        vm.startPrank(operatorEOA);

        // Deposit 100k
        interactor.depositToMorpho(address(morphoVault), 100_000e6);
        assertEq(usdc.balanceOf(address(safe)), 900_000e6);

        // Deposit another 50k
        interactor.depositToMorpho(address(morphoVault), 50_000e6);
        assertEq(usdc.balanceOf(address(safe)), 850_000e6);

        // Withdraw 30k
        interactor.withdrawFromMorpho(address(morphoVault), 30_000e6);
        assertEq(usdc.balanceOf(address(safe)), 880_000e6);

        vm.stopPrank();
    }

    // ============ Vault Removal Blocks Operations ============

    function test_removedVault_blocksDeposit() public {
        vm.prank(owner);
        interactor.removeAllowlistedVault(address(morphoVault));

        vm.expectRevert(abi.encodeWithSelector(DeFiInteractor.VaultNotAllowlisted.selector, address(morphoVault)));
        vm.prank(operatorEOA);
        interactor.depositToMorpho(address(morphoVault), 1000e6);
    }

    // ============ Ownership Transfer ============

    function test_transferOwnership() public {
        address newOwner = address(0x99);
        vm.prank(owner);
        interactor.transferOwnership(newOwner);

        // Owner has not changed yet (two-step)
        assertEq(interactor.owner(), owner);
        assertEq(interactor.pendingOwner(), newOwner);

        // New owner accepts ownership
        vm.prank(newOwner);
        interactor.acceptOwnership();
        assertEq(interactor.owner(), newOwner);
        assertEq(interactor.pendingOwner(), address(0));

        // Old owner cannot manage vaults
        vm.expectRevert();
        vm.prank(owner);
        interactor.addAllowlistedVault(address(0x123));

        // New owner can
        vm.prank(newOwner);
        interactor.addAllowlistedVault(address(0x123));
        assertTrue(interactor.isAllowlistedVault(address(0x123)));
    }

    // ============ Fuzz Tests ============

    function testFuzz_depositToMorpho_arbitraryAmounts(uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1_000_000e6);

        vm.prank(operatorEOA);
        uint256 shares = interactor.depositToMorpho(address(morphoVault), uint256(amount));

        assertGt(shares, 0);
        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - amount);
    }

    function testFuzz_supplyToAave_arbitraryAmounts(uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1_000_000e6);

        vm.prank(operatorEOA);
        interactor.supplyToAave(address(aavePool), address(usdc), uint256(amount));

        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - amount);
        assertEq(aavePool.deposits(address(safe), address(usdc)), amount);
    }
}
