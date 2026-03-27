// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ITenantRegistry} from "./interfaces/ITenantRegistry.sol";

/// @title TenantRegistry
/// @notice On-chain registry mapping tenantId to users to Safes. Provides O(1) lookups
///         for settlement validation and paginated views for off-chain indexing.
/// @dev Used by SpendSettler to validate settlement requests. Only the authorized
///      SafeFactory can register users; only the owner can register tenants.
contract TenantRegistry is ITenantRegistry, Ownable2Step {
    // ============ State Variables ============

    /// @notice O(1) lookup: tenantId => m2Safe => registered
    mapping(bytes32 => mapping(address => bool)) private _isUser;

    /// @notice Tenant metadata: tenantId => TenantInfo
    mapping(bytes32 => TenantInfo) private _tenantInfo;

    /// @notice Tenant user arrays for pagination: tenantId => user addresses
    mapping(bytes32 => address[]) private _tenantUsers;

    /// @notice User index in tenant array for swap-and-pop: tenantId => m2Safe => index
    mapping(bytes32 => mapping(address => uint256)) private _userIndex;

    /// @notice Reverse lookup: m2Safe => tenantId
    mapping(address => bytes32) private _safeToTenant;

    /// @notice Authorized factory address that can register users
    address public factory;

    // ============ Errors ============

    error InvalidAddress();
    error TenantAlreadyRegistered(bytes32 tenantId);
    error TenantNotRegistered(bytes32 tenantId);
    error TenantNotActive(bytes32 tenantId);
    error UserAlreadyRegistered(bytes32 tenantId, address m2Safe);
    error UserNotRegistered(bytes32 tenantId, address m2Safe);
    error OnlyFactory();
    error InvalidTenantId();

    // ============ Modifiers ============

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    // ============ Constructor ============

    /// @notice Initialize the registry
    /// @param _initialOwner The initial owner address (MultiSub admin)
    constructor(address _initialOwner) Ownable(_initialOwner) {}

    // ============ Factory Authorization ============

    /// @notice Set the authorized factory address
    /// @param _factory The SafeFactory address
    function setFactory(address _factory) external onlyOwner {
        if (_factory == address(0)) revert InvalidAddress();
        address oldFactory = factory;
        factory = _factory;
        emit FactoryUpdated(oldFactory, _factory);
    }

    // ============ Tenant Management ============

    /// @inheritdoc ITenantRegistry
    function registerTenant(bytes32 tenantId, address tenantSafe) external onlyOwner {
        if (tenantId == bytes32(0)) revert InvalidTenantId();
        if (tenantSafe == address(0)) revert InvalidAddress();
        if (_tenantInfo[tenantId].tenantSafe != address(0)) revert TenantAlreadyRegistered(tenantId);

        _tenantInfo[tenantId] = TenantInfo({tenantSafe: tenantSafe, userCount: 0, active: true});

        emit TenantRegistered(tenantId, tenantSafe);
    }

    /// @notice Deactivate a tenant (owner only)
    /// @param tenantId The tenant to deactivate
    function deactivateTenant(bytes32 tenantId) external onlyOwner {
        if (_tenantInfo[tenantId].tenantSafe == address(0)) revert TenantNotRegistered(tenantId);
        _tenantInfo[tenantId].active = false;
        emit TenantDeactivated(tenantId);
    }

    /// @notice Reactivate a tenant (owner only)
    /// @param tenantId The tenant to reactivate
    function reactivateTenant(bytes32 tenantId) external onlyOwner {
        if (_tenantInfo[tenantId].tenantSafe == address(0)) revert TenantNotRegistered(tenantId);
        _tenantInfo[tenantId].active = true;
        emit TenantReactivated(tenantId);
    }

    // ============ User Registration ============

    /// @inheritdoc ITenantRegistry
    function registerUser(bytes32 tenantId, address m2Safe) external onlyFactory {
        if (m2Safe == address(0)) revert InvalidAddress();
        if (_tenantInfo[tenantId].tenantSafe == address(0)) revert TenantNotRegistered(tenantId);
        if (!_tenantInfo[tenantId].active) revert TenantNotActive(tenantId);
        if (_isUser[tenantId][m2Safe]) revert UserAlreadyRegistered(tenantId, m2Safe);

        _isUser[tenantId][m2Safe] = true;
        _safeToTenant[m2Safe] = tenantId;
        _userIndex[tenantId][m2Safe] = _tenantUsers[tenantId].length;
        _tenantUsers[tenantId].push(m2Safe);
        _tenantInfo[tenantId].userCount++;

        emit UserRegistered(tenantId, m2Safe);
    }

    /// @notice Remove a user from a tenant (owner only, swap-and-pop)
    /// @param tenantId The tenant to remove the user from
    /// @param m2Safe The user Safe to remove
    function removeUser(bytes32 tenantId, address m2Safe) external onlyOwner {
        if (!_isUser[tenantId][m2Safe]) revert UserNotRegistered(tenantId, m2Safe);

        // Swap-and-pop removal
        uint256 index = _userIndex[tenantId][m2Safe];
        uint256 lastIndex = _tenantUsers[tenantId].length - 1;

        if (index != lastIndex) {
            address lastUser = _tenantUsers[tenantId][lastIndex];
            _tenantUsers[tenantId][index] = lastUser;
            _userIndex[tenantId][lastUser] = index;
        }
        _tenantUsers[tenantId].pop();
        delete _userIndex[tenantId][m2Safe];

        _isUser[tenantId][m2Safe] = false;
        delete _safeToTenant[m2Safe];
        _tenantInfo[tenantId].userCount--;

        emit UserRemoved(tenantId, m2Safe);
    }

    // ============ View Functions ============

    /// @inheritdoc ITenantRegistry
    function isRegisteredUser(bytes32 tenantId, address m2Safe) external view returns (bool) {
        return _isUser[tenantId][m2Safe];
    }

    /// @inheritdoc ITenantRegistry
    function getTenantInfo(bytes32 tenantId) external view returns (TenantInfo memory) {
        return _tenantInfo[tenantId];
    }

    /// @inheritdoc ITenantRegistry
    function getUsersForTenant(bytes32 tenantId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory users, uint256 total)
    {
        total = _tenantUsers[tenantId].length;

        if (offset >= total || limit == 0) {
            return (new address[](0), total);
        }

        uint256 remaining = total - offset;
        uint256 returnSize = remaining < limit ? remaining : limit;
        users = new address[](returnSize);

        for (uint256 i = 0; i < returnSize; i++) {
            users[i] = _tenantUsers[tenantId][offset + i];
        }

        return (users, total);
    }

    /// @inheritdoc ITenantRegistry
    function getTenantForSafe(address m2Safe) external view returns (bytes32) {
        return _safeToTenant[m2Safe];
    }

    /// @notice Check if a tenant is registered
    /// @param tenantId The tenant identifier
    /// @return Whether the tenant exists
    function isTenantRegistered(bytes32 tenantId) external view returns (bool) {
        return _tenantInfo[tenantId].tenantSafe != address(0);
    }

    /// @notice Check if a tenant is active
    /// @param tenantId The tenant identifier
    /// @return Whether the tenant is active
    function isTenantActive(bytes32 tenantId) external view returns (bool) {
        return _tenantInfo[tenantId].active;
    }
}
