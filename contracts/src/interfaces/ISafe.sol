// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, Operation operation)
        external
        returns (bool success);

    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function isModuleEnabled(address module) external view returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}
