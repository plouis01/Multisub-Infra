// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ISafeFactory
/// @notice Interface for the factory that deploys fully configured M2 Safe bundles
interface ISafeFactory {
    // ============ Enums ============

    /// @notice Custody model for the deployed Safe
    /// @dev MODEL_A = platform-custodial, MODEL_B = user-custodial
    enum CustodyModel {
        MODEL_A,
        MODEL_B
    }

    // ============ Events ============

    /// @notice Emitted when a new M2 Safe is deployed
    event SafeDeployed(
        bytes32 indexed tenantId,
        address indexed userSigner,
        address m2Safe,
        uint8 custodyModel,
        address spendSettler,
        address rolesModule,
        address delayModule
    );

    /// @notice Emitted when the registry address is updated
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice Emitted when the SpendSettler implementation is updated
    event SpendSettlerImplementationUpdated(address indexed oldImpl, address indexed newImpl);

    /// @notice Emitted when the issuer Safe is updated
    event IssuerSafeUpdated(address indexed oldIssuerSafe, address indexed newIssuerSafe);

    /// @notice Emitted when the USDC address is updated
    event UsdcUpdated(address indexed oldUsdc, address indexed newUsdc);

    /// @notice Emitted when a Roles Module is deployed alongside a Safe
    event RolesModuleDeployed(address indexed m2Safe, address indexed rolesModule);

    /// @notice Emitted when a Delay Module is deployed alongside a Safe
    event DelayModuleDeployed(address indexed m2Safe, address indexed delayModule);

    /// @notice Emitted when the Roles Module implementation is updated
    event RolesModuleImplementationUpdated(address indexed oldImpl, address indexed newImpl);

    /// @notice Emitted when the Delay Module implementation is updated
    event DelayModuleImplementationUpdated(address indexed oldImpl, address indexed newImpl);

    /// @notice Emitted when the M1 Treasury address is updated
    event M1TreasuryAddressUpdated(address indexed oldTreasury, address indexed newTreasury);

    /// @notice Emitted when the settler address is updated
    event SettlerUpdated(address indexed oldSettler, address indexed newSettler);

    // ============ Deployment ============

    /// @notice Deploy a fully configured M2 Safe with SpendSettler module
    /// @param tenantId The tenant this Safe belongs to
    /// @param userSigner The user's signing address (Safe owner)
    /// @param custodyModel 0 = MODEL_A (platform), 1 = MODEL_B (user)
    /// @return m2Safe The deployed Safe address
    function deploySafe(bytes32 tenantId, address userSigner, uint8 custodyModel) external returns (address m2Safe);

    /// @notice Predict the Safe address before deployment
    /// @param tenantId The tenant identifier
    /// @param userSigner The user's signing address
    /// @param nonce The deployment nonce
    /// @return predicted The predicted Safe address
    function computeSafeAddress(bytes32 tenantId, address userSigner, uint256 nonce)
        external
        view
        returns (address predicted);
}
