// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleSetupHelper
/// @notice Stateless helper contract that a Safe delegatecalls during setup()
///         to enable modules and initialize Zodiac clones. Because the Safe
///         delegatecalls this, `address(this)` is the Safe itself, so a
///         self-call to `enableModule` satisfies the `authorized` modifier.
/// @dev Deploy once and reuse across all SafeFactory deployments.
contract ModuleSetupHelper {
    error EnableModuleFailed(address module);
    error ZodiacSetUpFailed(address module);
    error LengthMismatch();

    /// @notice Enable multiple modules on the calling Safe and initialize
    ///         Zodiac clones via the standard `setUp(bytes)` signature.
    ///         Must be invoked via delegatecall from the Safe during setup().
    /// @param modules Array of module addresses to enable on the Safe
    /// @param zodiacModules Array of Zodiac module addresses that need setUp(bytes) init
    /// @param zodiacInitData Array of ABI-encoded init payloads (parallel with zodiacModules)
    function enableModules(
        address[] calldata modules,
        address[] calldata zodiacModules,
        bytes[] calldata zodiacInitData
    ) external {
        if (zodiacModules.length != zodiacInitData.length) revert LengthMismatch();

        // Enable all modules on the Safe.
        // Because we are executing inside a delegatecall from the Safe,
        // address(this) == the Safe. A self-call to enableModule therefore
        // passes the `authorized` (msg.sender == address(this)) check.
        for (uint256 i = 0; i < modules.length; i++) {
            (bool success,) = address(this).call(abi.encodeWithSignature("enableModule(address)", modules[i]));
            if (!success) revert EnableModuleFailed(modules[i]);
        }

        // Initialize Zodiac clones via the standard setUp(bytes) signature
        for (uint256 i = 0; i < zodiacModules.length; i++) {
            (bool success,) = zodiacModules[i].call(abi.encodeWithSignature("setUp(bytes)", zodiacInitData[i]));
            if (!success) revert ZodiacSetUpFailed(zodiacModules[i]);
        }
    }
}
