// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice Safe singleton mock for EIP-1167 clone testing. Supports setup() initialization
///         and module management. When cloned, the constructor does not run — setup() is
///         used instead to configure owners and threshold.
contract MockSafeSingleton {
    mapping(address => bool) public enabledModules;
    address[] public owners;
    uint256 public threshold;
    bool private _initialized;

    event ExecutedFromModule(address indexed module, address to, uint256 value, bytes data);
    event SafeSetup(address indexed initiator, address[] owners, uint256 threshold);

    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address,
        bytes calldata,
        address,
        address,
        uint256,
        address payable
    ) external {
        require(!_initialized, "Already initialized");
        require(_owners.length > 0, "No owners");
        require(_threshold > 0 && _threshold <= _owners.length, "Invalid threshold");

        for (uint256 i = 0; i < _owners.length; i++) {
            owners.push(_owners[i]);
        }
        threshold = _threshold;
        _initialized = true;

        emit SafeSetup(msg.sender, _owners, _threshold);
    }

    function enableModule(address module) external {
        enabledModules[module] = true;
    }

    function disableModule(address, address module) external {
        enabledModules[module] = false;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return enabledModules[module];
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, ISafe.Operation)
        external
        returns (bool success)
    {
        if (!enabledModules[msg.sender]) return false;
        (success,) = to.call{value: value}(data);
        emit ExecutedFromModule(msg.sender, to, value, data);
    }

    receive() external payable {}
}
