// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal mock of Zodiac Delay Module for EIP-1167 clone testing.
///         Does NOT initialize in constructor so it can be used as a singleton for cloning.
///         The `setUp` function acts as the initializer (matching Zodiac Delay Module pattern).
contract MockDelayModule {
    address public owner;
    address public avatar;
    address public target;
    uint256 public cooldown;
    uint256 public expiration;
    bool private _initialized;

    event DelayModuleSetUp(address indexed initiator, address indexed owner, address indexed avatar, address target);

    error AlreadyInitialized();
    error InvalidOwner();

    /// @notice Initialize the clone (called post-deployment instead of constructor)
    /// @param _owner The module owner (typically the Safe)
    /// @param _avatar The Safe this module is attached to
    /// @param _target The contract on which the module executes transactions
    function setUp(address _owner, address _avatar, address _target) external {
        if (_initialized) revert AlreadyInitialized();
        if (_owner == address(0)) revert InvalidOwner();

        owner = _owner;
        avatar = _avatar;
        target = _target;
        _initialized = true;

        emit DelayModuleSetUp(msg.sender, _owner, _avatar, _target);
    }

    /// @notice Check if initialized
    function initialized() external view returns (bool) {
        return _initialized;
    }
}
