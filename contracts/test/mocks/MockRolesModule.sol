// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock of Zodiac Roles v2 Module for EIP-1167 clone testing.
///         Does NOT initialize in constructor so it can be used as a singleton for cloning.
///         The `setUp` function acts as the initializer (matching Zodiac Roles v2 pattern).
contract MockRolesModule {
    address public owner;
    address public avatar;
    address public target;
    bool private _initialized;

    event RolesModuleSetUp(address indexed initiator, address indexed owner, address indexed avatar, address target);

    error AlreadyInitialized();
    error InvalidOwner();

    /// @notice Initialize the clone (called post-deployment instead of constructor)
    /// @dev Zodiac standard signature: setUp(bytes memory initializeParams)
    ///      where initializeParams = abi.encode(owner, avatar, target)
    /// @param initializeParams ABI-encoded (address owner, address avatar, address target)
    function setUp(bytes memory initializeParams) external {
        if (_initialized) revert AlreadyInitialized();

        (address _owner, address _avatar, address _target) = abi.decode(initializeParams, (address, address, address));

        if (_owner == address(0)) revert InvalidOwner();

        owner = _owner;
        avatar = _avatar;
        target = _target;
        _initialized = true;

        emit RolesModuleSetUp(msg.sender, _owner, _avatar, _target);
    }

    /// @notice Check if initialized
    function initialized() external view returns (bool) {
        return _initialized;
    }
}
