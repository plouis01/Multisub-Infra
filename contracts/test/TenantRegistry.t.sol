// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {TenantRegistry} from "../src/TenantRegistry.sol";
import {ITenantRegistry} from "../src/interfaces/ITenantRegistry.sol";

contract TenantRegistryTest is Test {
    TenantRegistry public registry;

    address public owner = address(0xAA);
    address public factory = address(0xBB);
    address public attacker = address(0xDD);
    address public tenantSafe = address(0xCC);

    bytes32 public tenantId = keccak256("tenant-001");
    bytes32 public tenantId2 = keccak256("tenant-002");

    function setUp() public {
        vm.prank(owner);
        registry = new TenantRegistry(owner);

        vm.prank(owner);
        registry.setFactory(factory);
    }

    // ============ Constructor Tests ============

    function test_constructor_setsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_constructor_factoryIsZeroInitially() public {
        vm.prank(owner);
        TenantRegistry fresh = new TenantRegistry(owner);
        assertEq(fresh.factory(), address(0));
    }

    // ============ Factory Authorization Tests ============

    function test_setFactory_updatesFactory() public {
        address newFactory = address(0xFF);
        vm.prank(owner);
        registry.setFactory(newFactory);
        assertEq(registry.factory(), newFactory);
    }

    function test_setFactory_emitsEvent() public {
        address newFactory = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ITenantRegistry.FactoryUpdated(factory, newFactory);

        vm.prank(owner);
        registry.setFactory(newFactory);
    }

    function test_setFactory_revertsOnZeroAddress() public {
        vm.expectRevert(TenantRegistry.InvalidAddress.selector);
        vm.prank(owner);
        registry.setFactory(address(0));
    }

    function test_setFactory_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        registry.setFactory(address(0xFF));
    }

    // ============ Tenant Registration Tests ============

    function test_registerTenant_registersSuccessfully() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
        assertEq(info.tenantSafe, tenantSafe);
        assertEq(info.userCount, 0);
        assertTrue(info.active);
    }

    function test_registerTenant_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit ITenantRegistry.TenantRegistered(tenantId, tenantSafe);

        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);
    }

    function test_registerTenant_revertsOnZeroTenantId() public {
        vm.expectRevert(TenantRegistry.InvalidTenantId.selector);
        vm.prank(owner);
        registry.registerTenant(bytes32(0), tenantSafe);
    }

    function test_registerTenant_revertsOnZeroAddress() public {
        vm.expectRevert(TenantRegistry.InvalidAddress.selector);
        vm.prank(owner);
        registry.registerTenant(tenantId, address(0));
    }

    function test_registerTenant_revertsOnDuplicate() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.TenantAlreadyRegistered.selector, tenantId));
        vm.prank(owner);
        registry.registerTenant(tenantId, address(0xEE));
    }

    function test_registerTenant_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        registry.registerTenant(tenantId, tenantSafe);
    }

    function test_registerTenant_multipleTenants() public {
        vm.startPrank(owner);
        registry.registerTenant(tenantId, tenantSafe);
        registry.registerTenant(tenantId2, address(0xEE));
        vm.stopPrank();

        assertTrue(registry.isTenantRegistered(tenantId));
        assertTrue(registry.isTenantRegistered(tenantId2));
    }

    // ============ Tenant Deactivation/Reactivation Tests ============

    function test_deactivateTenant_deactivates() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.prank(owner);
        registry.deactivateTenant(tenantId);

        assertFalse(registry.isTenantActive(tenantId));
    }

    function test_deactivateTenant_emitsEvent() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectEmit(true, false, false, false);
        emit ITenantRegistry.TenantDeactivated(tenantId);

        vm.prank(owner);
        registry.deactivateTenant(tenantId);
    }

    function test_deactivateTenant_revertsForUnregistered() public {
        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.TenantNotRegistered.selector, tenantId));
        vm.prank(owner);
        registry.deactivateTenant(tenantId);
    }

    function test_reactivateTenant_reactivates() public {
        vm.startPrank(owner);
        registry.registerTenant(tenantId, tenantSafe);
        registry.deactivateTenant(tenantId);
        registry.reactivateTenant(tenantId);
        vm.stopPrank();

        assertTrue(registry.isTenantActive(tenantId));
    }

    function test_reactivateTenant_emitsEvent() public {
        vm.startPrank(owner);
        registry.registerTenant(tenantId, tenantSafe);
        registry.deactivateTenant(tenantId);
        vm.stopPrank();

        vm.expectEmit(true, false, false, false);
        emit ITenantRegistry.TenantReactivated(tenantId);

        vm.prank(owner);
        registry.reactivateTenant(tenantId);
    }

    // ============ User Registration Tests ============

    function test_registerUser_registersSuccessfully() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        assertTrue(registry.isRegisteredUser(tenantId, m2Safe));
        assertEq(registry.getTenantForSafe(m2Safe), tenantId);

        ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
        assertEq(info.userCount, 1);
    }

    function test_registerUser_emitsEvent() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.expectEmit(true, true, false, false);
        emit ITenantRegistry.UserRegistered(tenantId, m2Safe);

        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);
    }

    function test_registerUser_revertsForNonFactory() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectRevert(TenantRegistry.OnlyFactory.selector);
        vm.prank(attacker);
        registry.registerUser(tenantId, address(0x1001));
    }

    function test_registerUser_revertsForOwner() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectRevert(TenantRegistry.OnlyFactory.selector);
        vm.prank(owner);
        registry.registerUser(tenantId, address(0x1001));
    }

    function test_registerUser_revertsOnZeroAddress() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectRevert(TenantRegistry.InvalidAddress.selector);
        vm.prank(factory);
        registry.registerUser(tenantId, address(0));
    }

    function test_registerUser_revertsForUnregisteredTenant() public {
        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.TenantNotRegistered.selector, tenantId));
        vm.prank(factory);
        registry.registerUser(tenantId, address(0x1001));
    }

    function test_registerUser_revertsForInactiveTenant() public {
        vm.startPrank(owner);
        registry.registerTenant(tenantId, tenantSafe);
        registry.deactivateTenant(tenantId);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.TenantNotActive.selector, tenantId));
        vm.prank(factory);
        registry.registerUser(tenantId, address(0x1001));
    }

    function test_registerUser_revertsOnDuplicate() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.UserAlreadyRegistered.selector, tenantId, m2Safe));
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);
    }

    function test_registerUser_multipleUsers() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.startPrank(factory);
        for (uint256 i = 0; i < 5; i++) {
            registry.registerUser(tenantId, address(uint160(0x1001 + i)));
        }
        vm.stopPrank();

        ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
        assertEq(info.userCount, 5);

        for (uint256 i = 0; i < 5; i++) {
            assertTrue(registry.isRegisteredUser(tenantId, address(uint160(0x1001 + i))));
        }
    }

    // ============ User Removal Tests ============

    function test_removeUser_removesSuccessfully() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        vm.prank(owner);
        registry.removeUser(tenantId, m2Safe);

        assertFalse(registry.isRegisteredUser(tenantId, m2Safe));
        assertEq(registry.getTenantForSafe(m2Safe), bytes32(0));

        ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
        assertEq(info.userCount, 0);
    }

    function test_removeUser_emitsEvent() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        vm.expectEmit(true, true, false, false);
        emit ITenantRegistry.UserRemoved(tenantId, m2Safe);

        vm.prank(owner);
        registry.removeUser(tenantId, m2Safe);
    }

    function test_removeUser_revertsForNonOwner() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        vm.expectRevert();
        vm.prank(attacker);
        registry.removeUser(tenantId, m2Safe);
    }

    function test_removeUser_revertsForUnregisteredUser() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.expectRevert(abi.encodeWithSelector(TenantRegistry.UserNotRegistered.selector, tenantId, address(0x1001)));
        vm.prank(owner);
        registry.removeUser(tenantId, address(0x1001));
    }

    function test_removeUser_swapAndPop() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        // Register 3 users
        address user1 = address(0x1001);
        address user2 = address(0x1002);
        address user3 = address(0x1003);

        vm.startPrank(factory);
        registry.registerUser(tenantId, user1);
        registry.registerUser(tenantId, user2);
        registry.registerUser(tenantId, user3);
        vm.stopPrank();

        // Remove middle user (triggers swap-and-pop)
        vm.prank(owner);
        registry.removeUser(tenantId, user2);

        // user1 and user3 should still be registered
        assertTrue(registry.isRegisteredUser(tenantId, user1));
        assertFalse(registry.isRegisteredUser(tenantId, user2));
        assertTrue(registry.isRegisteredUser(tenantId, user3));

        ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
        assertEq(info.userCount, 2);

        // Verify pagination still works correctly
        (address[] memory users, uint256 total) = registry.getUsersForTenant(tenantId, 0, 10);
        assertEq(total, 2);
        assertEq(users.length, 2);
    }

    // ============ Pagination Tests ============

    function test_getUsersForTenant_pagination() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        // Register 10 users
        vm.startPrank(factory);
        for (uint256 i = 0; i < 10; i++) {
            registry.registerUser(tenantId, address(uint160(0x1001 + i)));
        }
        vm.stopPrank();

        // Page 1: offset 0, limit 3
        (address[] memory page1, uint256 total1) = registry.getUsersForTenant(tenantId, 0, 3);
        assertEq(total1, 10);
        assertEq(page1.length, 3);
        assertEq(page1[0], address(uint160(0x1001)));
        assertEq(page1[1], address(uint160(0x1002)));
        assertEq(page1[2], address(uint160(0x1003)));

        // Page 2: offset 3, limit 3
        (address[] memory page2, uint256 total2) = registry.getUsersForTenant(tenantId, 3, 3);
        assertEq(total2, 10);
        assertEq(page2.length, 3);
        assertEq(page2[0], address(uint160(0x1004)));

        // Last page: offset 9, limit 5 (should return 1)
        (address[] memory lastPage, uint256 total3) = registry.getUsersForTenant(tenantId, 9, 5);
        assertEq(total3, 10);
        assertEq(lastPage.length, 1);
        assertEq(lastPage[0], address(uint160(0x100A)));
    }

    function test_getUsersForTenant_emptyTenant() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        (address[] memory users, uint256 total) = registry.getUsersForTenant(tenantId, 0, 10);
        assertEq(total, 0);
        assertEq(users.length, 0);
    }

    function test_getUsersForTenant_offsetBeyondTotal() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.prank(factory);
        registry.registerUser(tenantId, address(0x1001));

        (address[] memory users, uint256 total) = registry.getUsersForTenant(tenantId, 100, 10);
        assertEq(total, 1);
        assertEq(users.length, 0);
    }

    function test_getUsersForTenant_zeroLimit() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.prank(factory);
        registry.registerUser(tenantId, address(0x1001));

        (address[] memory users, uint256 total) = registry.getUsersForTenant(tenantId, 0, 0);
        assertEq(total, 1);
        assertEq(users.length, 0);
    }

    // ============ Reverse Lookup Tests ============

    function test_getTenantForSafe_returnsCorrectTenant() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        assertEq(registry.getTenantForSafe(m2Safe), tenantId);
    }

    function test_getTenantForSafe_returnsZeroForUnregistered() public view {
        assertEq(registry.getTenantForSafe(address(0x9999)), bytes32(0));
    }

    function test_getTenantForSafe_clearedAfterRemoval() public {
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        address m2Safe = address(0x1001);
        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        vm.prank(owner);
        registry.removeUser(tenantId, m2Safe);

        assertEq(registry.getTenantForSafe(m2Safe), bytes32(0));
    }

    // ============ View Function Tests ============

    function test_isTenantRegistered_returnsFalseForUnregistered() public view {
        assertFalse(registry.isTenantRegistered(tenantId));
    }

    function test_isTenantActive_returnsFalseForUnregistered() public view {
        assertFalse(registry.isTenantActive(tenantId));
    }

    function test_isRegisteredUser_returnsFalseForUnregistered() public view {
        assertFalse(registry.isRegisteredUser(tenantId, address(0x1001)));
    }

    // ============ Fuzz Tests ============

    function testFuzz_registerUser_arbitraryAddresses(address m2Safe) public {
        vm.assume(m2Safe != address(0));

        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        vm.prank(factory);
        registry.registerUser(tenantId, m2Safe);

        assertTrue(registry.isRegisteredUser(tenantId, m2Safe));
        assertEq(registry.getTenantForSafe(m2Safe), tenantId);
    }

    function testFuzz_registerTenant_arbitraryIds(bytes32 _tenantId) public {
        vm.assume(_tenantId != bytes32(0));

        vm.prank(owner);
        registry.registerTenant(_tenantId, tenantSafe);

        assertTrue(registry.isTenantRegistered(_tenantId));
    }

    // ============ Ownership Transfer Tests ============

    function test_transferOwnership() public {
        address newOwner = address(0x99);

        // Step 1: Current owner initiates transfer
        vm.prank(owner);
        registry.transferOwnership(newOwner);

        // Owner is still the old owner until accepted
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), newOwner);

        // Step 2: New owner accepts ownership
        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);

        // Old owner can no longer register tenants
        vm.expectRevert();
        vm.prank(owner);
        registry.registerTenant(tenantId, tenantSafe);

        // New owner can register tenants
        vm.prank(newOwner);
        registry.registerTenant(tenantId, tenantSafe);
    }
}
