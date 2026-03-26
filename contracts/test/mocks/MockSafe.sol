// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISafe} from "../../src/interfaces/ISafe.sol";

/// @notice Minimal Safe mock that executes module transactions by forwarding calls.
contract MockSafe {
    mapping(address => bool) public enabledModules;
    address[] public owners;
    uint256 public threshold;

    event ExecutedFromModule(address indexed module, address to, uint256 value, bytes data);

    constructor() {
        owners.push(msg.sender);
        threshold = 1;
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
        require(enabledModules[msg.sender], "Module not enabled");
        (success,) = to.call{value: value}(data);
        emit ExecutedFromModule(msg.sender, to, value, data);
    }

    receive() external payable {}
}
