// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.20;

import {ISafe} from "../interfaces/ISafe.sol";

/// @title Module
/// @notice Base contract for Zodiac-pattern modules that execute through a Safe
abstract contract Module {
    address public avatar;
    address public target;
    address public owner;

    event AvatarSet(address indexed previousAvatar, address indexed newAvatar);
    event TargetSet(address indexed previousTarget, address indexed newTarget);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error InvalidAddress();
    error ModuleTransactionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _avatar, address _target, address _owner) {
        if (_avatar == address(0) || _target == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }
        avatar = _avatar;
        target = _target;
        owner = _owner;

        emit AvatarSet(address(0), _avatar);
        emit TargetSet(address(0), _target);
        emit OwnershipTransferred(address(0), _owner);
    }

    function setAvatar(address _avatar) public onlyOwner {
        if (_avatar == address(0)) revert InvalidAddress();
        address prev = avatar;
        avatar = _avatar;
        emit AvatarSet(prev, _avatar);
    }

    function setTarget(address _target) public onlyOwner {
        if (_target == address(0)) revert InvalidAddress();
        address prev = target;
        target = _target;
        emit TargetSet(prev, _target);
    }

    function transferOwnership(address _newOwner) public onlyOwner {
        if (_newOwner == address(0)) revert InvalidAddress();
        address prev = owner;
        owner = _newOwner;
        emit OwnershipTransferred(prev, _newOwner);
    }

    function exec(address to, uint256 value, bytes memory data, ISafe.Operation operation)
        internal
        returns (bool success)
    {
        return ISafe(target).execTransactionFromModule(to, value, data, operation);
    }
}
