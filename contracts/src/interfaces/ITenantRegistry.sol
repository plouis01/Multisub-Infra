// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ITenantRegistry
/// @notice Interface for the on-chain registry mapping tenantId to users to Safes
interface ITenantRegistry {
    // ============ Structs ============

    /// @notice Tenant configuration and metadata
    struct TenantInfo {
        address tenantSafe;
        uint256 userCount;
        bool active;
    }

    // ============ Events ============

    /// @notice Emitted when a new tenant is registered
    event TenantRegistered(bytes32 indexed tenantId, address indexed tenantSafe);

    /// @notice Emitted when a tenant is deactivated
    event TenantDeactivated(bytes32 indexed tenantId);

    /// @notice Emitted when a tenant is reactivated
    event TenantReactivated(bytes32 indexed tenantId);

    /// @notice Emitted when a user Safe is registered under a tenant
    event UserRegistered(bytes32 indexed tenantId, address indexed m2Safe);

    /// @notice Emitted when a user Safe is removed from a tenant
    event UserRemoved(bytes32 indexed tenantId, address indexed m2Safe);

    /// @notice Emitted when the authorized factory is updated
    event FactoryUpdated(address indexed oldFactory, address indexed newFactory);

    // ============ Tenant Management ============

    /// @notice Register a new tenant (owner only)
    /// @param tenantId Unique identifier for the tenant
    /// @param tenantSafe The tenant's Safe address
    function registerTenant(bytes32 tenantId, address tenantSafe) external;

    // ============ User Registration ============

    /// @notice Register a user Safe under a tenant (factory only)
    /// @param tenantId The tenant to register the user under
    /// @param m2Safe The user's M2 Safe address
    function registerUser(bytes32 tenantId, address m2Safe) external;

    // ============ View Functions ============

    /// @notice Check if a Safe is a registered user for a tenant (O(1) lookup)
    /// @param tenantId The tenant identifier
    /// @param m2Safe The Safe address to check
    /// @return registered Whether the Safe is registered
    function isRegisteredUser(bytes32 tenantId, address m2Safe) external view returns (bool registered);

    /// @notice Get tenant info
    /// @param tenantId The tenant identifier
    /// @return info The tenant information
    function getTenantInfo(bytes32 tenantId) external view returns (TenantInfo memory info);

    /// @notice Get paginated list of user Safes for a tenant
    /// @param tenantId The tenant identifier
    /// @param offset Starting index
    /// @param limit Maximum number of results
    /// @return users Array of user Safe addresses
    /// @return total Total number of registered users
    function getUsersForTenant(bytes32 tenantId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory users, uint256 total);

    /// @notice Reverse lookup: get the tenant a Safe belongs to
    /// @param m2Safe The Safe address
    /// @return tenantId The tenant identifier (bytes32(0) if not found)
    function getTenantForSafe(address m2Safe) external view returns (bytes32 tenantId);
}
