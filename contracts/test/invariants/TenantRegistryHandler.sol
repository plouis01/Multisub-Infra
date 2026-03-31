// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TenantRegistry} from "../../src/TenantRegistry.sol";
import {ITenantRegistry} from "../../src/interfaces/ITenantRegistry.sol";

/// @notice Handler contract for TenantRegistry invariant (stateful fuzz) tests.
///         Exposes bounded registration/removal actions that the fuzzer calls in random sequences.
contract TenantRegistryHandler is Test {
    TenantRegistry public registry;
    address public owner;
    address public factory;

    // Pre-allocated tenant IDs and user addresses
    bytes32[] public tenantIds;
    address[] public userAddresses;

    // Track which tenants are registered
    mapping(bytes32 => bool) public ghost_tenantRegistered;
    bytes32[] public registeredTenants;

    // Track which users are registered under which tenant
    mapping(bytes32 => mapping(address => bool)) public ghost_isUser;
    mapping(bytes32 => address[]) public ghost_tenantUsers;

    // Track safe-to-tenant mapping
    mapping(address => bytes32) public ghost_safeToTenant;

    // Call counters
    uint256 public calls_registerTenant;
    uint256 public calls_registerUser;
    uint256 public calls_removeUser;

    constructor(TenantRegistry _registry, address _owner, address _factory) {
        registry = _registry;
        owner = _owner;
        factory = _factory;

        // Pre-create 5 tenant IDs
        for (uint256 i = 1; i <= 5; i++) {
            tenantIds.push(bytes32(uint256(i)));
        }

        // Pre-create 20 user addresses
        for (uint256 i = 1; i <= 20; i++) {
            userAddresses.push(address(uint160(0x1000 + i)));
        }
    }

    /// @notice Register a new tenant
    function registerTenant(uint256 tenantSeed) external {
        bytes32 tenantId = tenantIds[tenantSeed % tenantIds.length];

        // Skip if already registered
        if (ghost_tenantRegistered[tenantId]) return;

        address tenantSafe = address(uint160(uint256(tenantId) + 0x2000));

        vm.prank(owner);
        try registry.registerTenant(tenantId, tenantSafe) {
            ghost_tenantRegistered[tenantId] = true;
            registeredTenants.push(tenantId);
            calls_registerTenant++;
        } catch {}
    }

    /// @notice Register a user under a random tenant
    function registerUser(uint256 tenantSeed, uint256 userSeed) external {
        if (registeredTenants.length == 0) return;

        bytes32 tenantId = registeredTenants[tenantSeed % registeredTenants.length];
        address userAddr = userAddresses[userSeed % userAddresses.length];

        // Skip if already registered
        if (ghost_isUser[tenantId][userAddr]) return;
        // Skip if user is registered under a different tenant
        if (ghost_safeToTenant[userAddr] != bytes32(0)) return;

        vm.prank(factory);
        try registry.registerUser(tenantId, userAddr) {
            ghost_isUser[tenantId][userAddr] = true;
            ghost_tenantUsers[tenantId].push(userAddr);
            ghost_safeToTenant[userAddr] = tenantId;
            calls_registerUser++;
        } catch {}
    }

    /// @notice Remove a user from a random tenant
    function removeUser(uint256 tenantSeed, uint256 userSeed) external {
        if (registeredTenants.length == 0) return;

        bytes32 tenantId = registeredTenants[tenantSeed % registeredTenants.length];
        address[] storage users = ghost_tenantUsers[tenantId];
        if (users.length == 0) return;

        uint256 idx = userSeed % users.length;
        address userAddr = users[idx];

        vm.prank(owner);
        try registry.removeUser(tenantId, userAddr) {
            ghost_isUser[tenantId][userAddr] = false;
            delete ghost_safeToTenant[userAddr];

            // Swap-and-pop from ghost array (mirrors contract logic)
            uint256 lastIdx = users.length - 1;
            if (idx != lastIdx) {
                users[idx] = users[lastIdx];
            }
            users.pop();

            calls_removeUser++;
        } catch {}
    }

    /// @notice Get count of registered tenants
    function registeredTenantCount() external view returns (uint256) {
        return registeredTenants.length;
    }

    /// @notice Get ghost user count for a tenant
    function ghostUserCount(bytes32 tenantId) external view returns (uint256) {
        return ghost_tenantUsers[tenantId].length;
    }

    /// @notice Get ghost user at index for a tenant
    function ghostUserAt(bytes32 tenantId, uint256 index) external view returns (address) {
        return ghost_tenantUsers[tenantId][index];
    }
}
