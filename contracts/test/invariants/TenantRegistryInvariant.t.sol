// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TenantRegistry} from "../../src/TenantRegistry.sol";
import {ITenantRegistry} from "../../src/interfaces/ITenantRegistry.sol";
import {TenantRegistryHandler} from "./TenantRegistryHandler.sol";

/// @notice Invariant tests for TenantRegistry.
///         Verifies registration data structure invariants hold after arbitrary
///         sequences of tenant registrations, user registrations, and user removals.
contract TenantRegistryInvariantTest is Test {
    TenantRegistryHandler public handler;
    TenantRegistry public registry;

    address public owner = address(0xAA);
    address public factory = address(0xBB);

    function setUp() public {
        // Deploy TenantRegistry
        vm.prank(owner);
        registry = new TenantRegistry(owner);

        // Set factory
        vm.prank(owner);
        registry.setFactory(factory);

        // Deploy handler
        handler = new TenantRegistryHandler(registry, owner, factory);

        // Target only the handler for fuzzing
        targetContract(address(handler));
    }

    // ============ Invariant 1: tenantInfo.userCount == _tenantUsers.length ============

    function invariant_userCountMatchesArrayLength() public view {
        uint256 tenantCount = handler.registeredTenantCount();
        for (uint256 i = 0; i < tenantCount; i++) {
            bytes32 tenantId = handler.registeredTenants(i);
            ITenantRegistry.TenantInfo memory info = registry.getTenantInfo(tenantId);
            uint256 ghostCount = handler.ghostUserCount(tenantId);

            assertEq(info.userCount, ghostCount, "userCount does not match actual user array length");
        }
    }

    // ============ Invariant 2: isRegisteredUser consistency ============

    function invariant_isRegisteredUserConsistency() public view {
        uint256 tenantCount = handler.registeredTenantCount();
        for (uint256 i = 0; i < tenantCount; i++) {
            bytes32 tenantId = handler.registeredTenants(i);
            uint256 userCount = handler.ghostUserCount(tenantId);

            // Every user in the ghost array should be registered
            for (uint256 j = 0; j < userCount; j++) {
                address user = handler.ghostUserAt(tenantId, j);
                assertTrue(registry.isRegisteredUser(tenantId, user), "User in ghost array not registered in contract");
            }
        }
    }

    // ============ Invariant 3: getTenantForSafe returns correct tenantId ============

    function invariant_safeToTenantMapping() public view {
        uint256 tenantCount = handler.registeredTenantCount();
        for (uint256 i = 0; i < tenantCount; i++) {
            bytes32 tenantId = handler.registeredTenants(i);
            uint256 userCount = handler.ghostUserCount(tenantId);

            for (uint256 j = 0; j < userCount; j++) {
                address user = handler.ghostUserAt(tenantId, j);
                assertEq(registry.getTenantForSafe(user), tenantId, "getTenantForSafe returned wrong tenantId");
            }
        }
    }

    // ============ Invariant 4: Removed users are no longer registered ============

    function invariant_removedUsersNotRegistered() public view {
        // Check all 20 pre-allocated user addresses
        for (uint256 i = 1; i <= 20; i++) {
            address userAddr = address(uint160(0x1000 + i));
            bytes32 safeTenant = registry.getTenantForSafe(userAddr);

            if (safeTenant == bytes32(0)) {
                // User is not mapped to any tenant -- verify isRegistered is false for all tenants
                uint256 tenantCount = handler.registeredTenantCount();
                for (uint256 j = 0; j < tenantCount; j++) {
                    bytes32 tenantId = handler.registeredTenants(j);
                    assertFalse(
                        registry.isRegisteredUser(tenantId, userAddr), "User with no tenant mapping still registered"
                    );
                }
            }
        }
    }

    /// @notice Log call statistics after all invariant runs
    function invariant_callSummary() public view {
        assert(true);
    }
}
