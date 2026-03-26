// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {SpendSettler} from "../src/SpendSettler.sol";
import {ISpendSettler} from "../src/interfaces/ISpendSettler.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SpendSettlerTest is Test {
    SpendSettler public settler;
    MockSafe public safe;
    MockERC20 public usdc;

    address public owner = address(0xAA);
    address public settlerEOA = address(0xBB);
    address public issuerSafe = address(0xCC);
    address public attacker = address(0xDD);

    function setUp() public {
        safe = new MockSafe();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.prank(owner);
        settler = new SpendSettler(address(safe), owner, settlerEOA, issuerSafe, address(usdc));

        // Enable the module on the Safe
        safe.enableModule(address(settler));

        // Fund the Safe with USDC
        usdc.mint(address(safe), 1_000_000e6);
    }

    // ============ Constructor Tests ============

    function test_constructor_setsStateCorrectly() public view {
        assertEq(settler.avatar(), address(safe));
        assertEq(settler.target(), address(safe));
        assertEq(settler.owner(), owner);
        assertEq(settler.settler(), settlerEOA);
        assertEq(settler.issuerSafe(), issuerSafe);
        assertEq(settler.usdc(), address(usdc));
        assertEq(settler.nonce(), 0);
        assertEq(settler.totalSettled(), 0);
    }

    function test_constructor_revertsOnZeroAvatar() public {
        vm.expectRevert();
        new SpendSettler(address(0), owner, settlerEOA, issuerSafe, address(usdc));
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert();
        new SpendSettler(address(safe), address(0), settlerEOA, issuerSafe, address(usdc));
    }

    function test_constructor_revertsOnZeroSettler() public {
        vm.expectRevert(SpendSettler.InvalidSettler.selector);
        new SpendSettler(address(safe), owner, address(0), issuerSafe, address(usdc));
    }

    function test_constructor_revertsOnZeroIssuerSafe() public {
        vm.expectRevert(SpendSettler.InvalidIssuerSafe.selector);
        new SpendSettler(address(safe), owner, settlerEOA, address(0), address(usdc));
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(SpendSettler.InvalidUsdcAddress.selector);
        new SpendSettler(address(safe), owner, settlerEOA, issuerSafe, address(0));
    }

    // ============ Core Settlement Tests ============

    function test_settle_transfersUSDC() public {
        bytes32 txToken = keccak256("tx-001");
        uint256 amount = 100e6; // 100 USDC

        vm.prank(settlerEOA);
        settler.settle(amount, txToken);

        assertEq(usdc.balanceOf(issuerSafe), amount);
        assertEq(usdc.balanceOf(address(safe)), 1_000_000e6 - amount);
    }

    function test_settle_emitsSpendSettledEvent() public {
        bytes32 txToken = keccak256("tx-001");
        uint256 amount = 50e6;

        vm.expectEmit(true, true, true, true);
        emit ISpendSettler.SpendSettled(address(safe), issuerSafe, amount, txToken, 0);

        vm.prank(settlerEOA);
        settler.settle(amount, txToken);
    }

    function test_settle_incrementsNonce() public {
        vm.startPrank(settlerEOA);
        settler.settle(10e6, keccak256("tx-001"));
        assertEq(settler.nonce(), 1);

        settler.settle(20e6, keccak256("tx-002"));
        assertEq(settler.nonce(), 2);

        settler.settle(30e6, keccak256("tx-003"));
        assertEq(settler.nonce(), 3);
        vm.stopPrank();
    }

    function test_settle_updatesTotalSettled() public {
        vm.startPrank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
        assertEq(settler.getTotalSettled(), 100e6);

        settler.settle(200e6, keccak256("tx-002"));
        assertEq(settler.getTotalSettled(), 300e6);
        vm.stopPrank();
    }

    function test_settle_tracksRollingSpend() public {
        vm.startPrank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
        assertEq(settler.getRollingSpend(), 100e6);

        settler.settle(200e6, keccak256("tx-002"));
        assertEq(settler.getRollingSpend(), 300e6);
        vm.stopPrank();
    }

    function test_settle_rollingSpendExpiresAfter24h() public {
        vm.prank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
        assertEq(settler.getRollingSpend(), 100e6);

        // Advance 25 hours
        vm.warp(block.timestamp + 25 hours);

        assertEq(settler.getRollingSpend(), 0);

        // New spend should only reflect current
        vm.prank(settlerEOA);
        settler.settle(50e6, keccak256("tx-002"));
        assertEq(settler.getRollingSpend(), 50e6);
    }

    // ============ Idempotency Tests ============

    function test_settle_revertsOnDuplicateTxToken() public {
        bytes32 txToken = keccak256("tx-001");

        vm.prank(settlerEOA);
        settler.settle(100e6, txToken);

        vm.expectRevert(abi.encodeWithSelector(SpendSettler.AlreadySettled.selector, txToken));
        vm.prank(settlerEOA);
        settler.settle(100e6, txToken);
    }

    function test_isSettled_returnsCorrectState() public {
        bytes32 txToken = keccak256("tx-001");
        assertFalse(settler.isSettled(txToken));

        vm.prank(settlerEOA);
        settler.settle(100e6, txToken);

        assertTrue(settler.isSettled(txToken));
    }

    // ============ Access Control Tests ============

    function test_settle_revertsForNonSettler() public {
        vm.expectRevert(SpendSettler.OnlySettler.selector);
        vm.prank(attacker);
        settler.settle(100e6, keccak256("tx-001"));
    }

    function test_settle_revertsForOwner() public {
        vm.expectRevert(SpendSettler.OnlySettler.selector);
        vm.prank(owner);
        settler.settle(100e6, keccak256("tx-001"));
    }

    function test_settle_revertsOnZeroAmount() public {
        vm.expectRevert(SpendSettler.ZeroAmount.selector);
        vm.prank(settlerEOA);
        settler.settle(0, keccak256("tx-001"));
    }

    // ============ Pause Tests ============

    function test_pause_preventsSettlement() public {
        vm.prank(owner);
        settler.pause();

        vm.expectRevert();
        vm.prank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
    }

    function test_unpause_allowsSettlement() public {
        vm.prank(owner);
        settler.pause();

        vm.prank(owner);
        settler.unpause();

        vm.prank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
        assertEq(usdc.balanceOf(issuerSafe), 100e6);
    }

    function test_pause_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        settler.pause();
    }

    // ============ Admin Function Tests ============

    function test_setSettler_updatesSettler() public {
        address newSettler = address(0xEE);
        vm.prank(owner);
        settler.setSettler(newSettler);
        assertEq(settler.settler(), newSettler);
    }

    function test_setSettler_revertsOnZero() public {
        vm.expectRevert(SpendSettler.InvalidSettler.selector);
        vm.prank(owner);
        settler.setSettler(address(0));
    }

    function test_setSettler_onlyOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        settler.setSettler(address(0xEE));
    }

    function test_setIssuerSafe_updatesAddress() public {
        address newIssuer = address(0xFF);
        vm.prank(owner);
        settler.setIssuerSafe(newIssuer);
        assertEq(settler.issuerSafe(), newIssuer);
    }

    function test_setIssuerSafe_revertsOnZero() public {
        vm.expectRevert(SpendSettler.InvalidIssuerSafe.selector);
        vm.prank(owner);
        settler.setIssuerSafe(address(0));
    }

    function test_setUsdc_updatesAddress() public {
        address newUsdc = address(0x11);
        vm.prank(owner);
        settler.setUsdc(newUsdc);
        assertEq(settler.usdc(), newUsdc);
    }

    function test_setUsdc_revertsOnZero() public {
        vm.expectRevert(SpendSettler.InvalidUsdcAddress.selector);
        vm.prank(owner);
        settler.setUsdc(address(0));
    }

    // ============ Active Record Count Tests ============

    function test_getActiveRecordCount() public {
        assertEq(settler.getActiveRecordCount(), 0);

        vm.startPrank(settlerEOA);
        settler.settle(10e6, keccak256("tx-001"));
        assertEq(settler.getActiveRecordCount(), 1);

        settler.settle(20e6, keccak256("tx-002"));
        assertEq(settler.getActiveRecordCount(), 2);
        vm.stopPrank();

        // After 25 hours and a new settlement, old records should be cleaned
        vm.warp(block.timestamp + 25 hours);
        vm.prank(settlerEOA);
        settler.settle(5e6, keccak256("tx-003"));
        assertEq(settler.getActiveRecordCount(), 1);
    }

    // ============ Fuzz Tests ============

    function testFuzz_settle_arbitraryAmounts(uint128 amount) public {
        vm.assume(amount > 0);
        vm.assume(amount <= 1_000_000e6);

        vm.prank(settlerEOA);
        settler.settle(uint256(amount), keccak256(abi.encode(amount)));

        assertEq(usdc.balanceOf(issuerSafe), amount);
        assertEq(settler.getTotalSettled(), amount);
    }

    function testFuzz_settle_uniqueTxTokens(bytes32 token1, bytes32 token2) public {
        vm.assume(token1 != token2);

        vm.startPrank(settlerEOA);
        settler.settle(10e6, token1);
        settler.settle(10e6, token2);
        vm.stopPrank();

        assertTrue(settler.isSettled(token1));
        assertTrue(settler.isSettled(token2));
        assertEq(settler.nonce(), 2);
    }

    // ============ Gas Test ============

    function test_settle_gasUsage() public {
        // Warm up storage with a first settlement (cold SSTORE is expensive)
        vm.prank(settlerEOA);
        settler.settle(1e6, keccak256("warmup"));

        bytes32 txToken = keccak256("gas-test");
        uint256 gasBefore = gasleft();

        vm.prank(settlerEOA);
        settler.settle(100e6, txToken);

        uint256 gasUsed = gasBefore - gasleft();
        // Warm-path gas should be well under 100K (cold-path first settlement is higher
        // due to SSTORE costs, but Base mainnet with EIP-4844 is cheaper)
        assertLt(gasUsed, 100_000, "Gas usage exceeds 100K target");
    }

    // ============ Edge Case: Module Not Enabled ============

    function test_settle_revertsWhenModuleDisabled() public {
        safe.disableModule(address(0), address(settler));

        vm.expectRevert(); // Safe reverts with "Module not enabled"
        vm.prank(settlerEOA);
        settler.settle(100e6, keccak256("tx-001"));
    }

    // ============ Edge Case: Insufficient USDC ============

    function test_settle_revertsOnInsufficientBalance() public {
        // Try to settle more than Safe has
        vm.expectRevert(SpendSettler.TransferFailed.selector);
        vm.prank(settlerEOA);
        settler.settle(2_000_000e6, keccak256("tx-001"));
    }

    // ============ Multiple Settlements ============

    function test_settle_multipleInSequence() public {
        vm.startPrank(settlerEOA);

        for (uint256 i = 0; i < 10; i++) {
            settler.settle(1000e6, keccak256(abi.encode(i)));
        }

        vm.stopPrank();

        assertEq(usdc.balanceOf(issuerSafe), 10_000e6);
        assertEq(settler.nonce(), 10);
        assertEq(settler.getTotalSettled(), 10_000e6);
        assertEq(settler.getRollingSpend(), 10_000e6);
        assertEq(settler.getActiveRecordCount(), 10);
    }

    // ============ Ownership Transfer ============

    function test_transferOwnership() public {
        address newOwner = address(0x99);
        vm.prank(owner);
        settler.transferOwnership(newOwner);
        assertEq(settler.owner(), newOwner);

        // Old owner can no longer pause
        vm.expectRevert();
        vm.prank(owner);
        settler.pause();

        // New owner can pause
        vm.prank(newOwner);
        settler.pause();
    }
}
