// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ISafeFactory} from "./interfaces/ISafeFactory.sol";
import {ITenantRegistry} from "./interfaces/ITenantRegistry.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {SpendSettler} from "./SpendSettler.sol";

/// @title SafeFactory
/// @notice Factory that deploys a fully configured M2 Safe bundle in a single transaction
///         using CREATE2 for deterministic addresses. Deploys Safe proxy + SpendSettler
///         module and auto-registers in the TenantRegistry.
/// @dev Uses EIP-1167 minimal proxy clones for Safe deployment to reduce gas costs.
///      SpendSettler is deployed via CREATE2 with full bytecode since it requires
///      constructor-based initialization (Module base contract pattern).
///      Gas target: <500K on Base.
contract SafeFactory is ISafeFactory, Ownable {
    // ============ State Variables ============

    /// @notice Safe singleton (implementation) to clone
    address public safeImplementation;

    /// @notice SpendSettler implementation for reference
    address public spendSettlerImplementation;

    /// @notice Settlement service backend address
    address public settler;

    /// @notice Platform Issuer Safe receiving settlement funds
    address public issuerSafe;

    /// @notice USDC token address on Base
    address public usdc;

    /// @notice TenantRegistry for auto-registration
    ITenantRegistry public registry;

    /// @notice Nonce per tenant for CREATE2 salt uniqueness
    mapping(bytes32 => uint256) public deploymentNonce;

    /// @notice All deployed Safes: tenantId => list of deployed Safe addresses
    mapping(bytes32 => address[]) private _deployedSafes;

    /// @notice Reverse lookup: m2Safe => SpendSettler module
    mapping(address => address) public safeToSettler;

    /// @notice Zodiac Roles v2 singleton to clone
    address public rolesModuleImplementation;

    /// @notice Delay Module singleton to clone
    address public delayModuleImplementation;

    /// @notice M1 Treasury address for sweeper role scoping
    address public m1TreasuryAddress;

    /// @notice Reverse lookup: m2Safe => Roles Module
    mapping(address => address) public safeToRoles;

    /// @notice Reverse lookup: m2Safe => Delay Module
    mapping(address => address) public safeToDelay;

    // ============ Errors ============

    error InvalidAddress();
    error InvalidCustodyModel(uint8 model);
    error RegistryNotSet();
    error DeploymentFailed();
    error SafeSetupFailed();
    error InvalidTenantId();

    // ============ Constructor ============

    /// @notice Initialize the factory
    /// @param _initialOwner The initial owner (MultiSub admin)
    /// @param _safeImplementation Safe singleton to clone
    /// @param _spendSettlerImplementation SpendSettler implementation address
    /// @param _settler Settlement service backend address
    /// @param _issuerSafe Platform Issuer Safe address
    /// @param _usdc USDC token address
    /// @param _rolesModuleImpl Zodiac Roles v2 singleton to clone (address(0) to skip)
    /// @param _delayModuleImpl Delay Module singleton to clone (address(0) to skip)
    constructor(
        address _initialOwner,
        address _safeImplementation,
        address _spendSettlerImplementation,
        address _settler,
        address _issuerSafe,
        address _usdc,
        address _rolesModuleImpl,
        address _delayModuleImpl
    ) Ownable(_initialOwner) {
        if (_safeImplementation == address(0)) revert InvalidAddress();
        if (_spendSettlerImplementation == address(0)) revert InvalidAddress();
        if (_settler == address(0)) revert InvalidAddress();
        if (_issuerSafe == address(0)) revert InvalidAddress();
        if (_usdc == address(0)) revert InvalidAddress();

        safeImplementation = _safeImplementation;
        spendSettlerImplementation = _spendSettlerImplementation;
        settler = _settler;
        issuerSafe = _issuerSafe;
        usdc = _usdc;
        rolesModuleImplementation = _rolesModuleImpl;
        delayModuleImplementation = _delayModuleImpl;
    }

    // ============ Configuration ============

    /// @notice Set the TenantRegistry address
    /// @param _registry The registry address
    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        address oldRegistry = address(registry);
        registry = ITenantRegistry(_registry);
        emit RegistryUpdated(oldRegistry, _registry);
    }

    /// @notice Set the SpendSettler implementation address
    /// @param _impl The new implementation address
    function setSpendSettlerImplementation(address _impl) external onlyOwner {
        if (_impl == address(0)) revert InvalidAddress();
        address oldImpl = spendSettlerImplementation;
        spendSettlerImplementation = _impl;
        emit SpendSettlerImplementationUpdated(oldImpl, _impl);
    }

    /// @notice Set the Issuer Safe address
    /// @param _issuerSafe The new Issuer Safe address
    function setIssuerSafe(address _issuerSafe) external onlyOwner {
        if (_issuerSafe == address(0)) revert InvalidAddress();
        address oldIssuer = issuerSafe;
        issuerSafe = _issuerSafe;
        emit IssuerSafeUpdated(oldIssuer, _issuerSafe);
    }

    /// @notice Set the USDC token address
    /// @param _usdc The new USDC address
    function setUsdc(address _usdc) external onlyOwner {
        if (_usdc == address(0)) revert InvalidAddress();
        address oldUsdc = usdc;
        usdc = _usdc;
        emit UsdcUpdated(oldUsdc, _usdc);
    }

    /// @notice Set the Zodiac Roles v2 Module implementation address
    /// @param _impl The new implementation address (address(0) to disable)
    function setRolesModuleImplementation(address _impl) external onlyOwner {
        address oldImpl = rolesModuleImplementation;
        rolesModuleImplementation = _impl;
        emit RolesModuleImplementationUpdated(oldImpl, _impl);
    }

    /// @notice Set the Delay Module implementation address
    /// @param _impl The new implementation address (address(0) to disable)
    function setDelayModuleImplementation(address _impl) external onlyOwner {
        address oldImpl = delayModuleImplementation;
        delayModuleImplementation = _impl;
        emit DelayModuleImplementationUpdated(oldImpl, _impl);
    }

    /// @notice Set the M1 Treasury address for sweeper role scoping
    /// @param _treasury The new treasury address
    function setM1TreasuryAddress(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert InvalidAddress();
        address oldTreasury = m1TreasuryAddress;
        m1TreasuryAddress = _treasury;
        emit M1TreasuryAddressUpdated(oldTreasury, _treasury);
    }

    // ============ Salt Generation ============

    /// @notice Generate deterministic salt for CREATE2
    /// @param tenantId The tenant identifier
    /// @param userSigner The user's signing address
    /// @param nonce Deployment nonce for uniqueness
    /// @return salt The computed salt
    function computeSalt(bytes32 tenantId, address userSigner, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(tenantId, userSigner, nonce));
    }

    // ============ Address Prediction ============

    /// @inheritdoc ISafeFactory
    function computeSafeAddress(bytes32 tenantId, address userSigner, uint256 nonce)
        external
        view
        returns (address predicted)
    {
        bytes32 salt = computeSalt(tenantId, userSigner, nonce);
        return Clones.predictDeterministicAddress(safeImplementation, salt, address(this));
    }

    // ============ Deployment ============

    /// @inheritdoc ISafeFactory
    function deploySafe(bytes32 tenantId, address userSigner, uint8 custodyModel)
        external
        onlyOwner
        returns (address m2Safe)
    {
        if (tenantId == bytes32(0)) revert InvalidTenantId();
        if (userSigner == address(0)) revert InvalidAddress();
        if (custodyModel > 1) revert InvalidCustodyModel(custodyModel);
        if (address(registry) == address(0)) revert RegistryNotSet();

        uint256 nonce = deploymentNonce[tenantId];
        bytes32 salt = computeSalt(tenantId, userSigner, nonce);

        // Step 1: Deploy Safe proxy via EIP-1167 minimal proxy clone
        m2Safe = Clones.cloneDeterministic(safeImplementation, salt);
        if (m2Safe == address(0)) revert DeploymentFailed();

        // Step 2: Configure Safe — set userSigner as owner with threshold 1
        address[] memory owners = new address[](1);
        owners[0] = userSigner;

        // Setup Safe: owners, threshold, to (delegatecall target), data, fallbackHandler,
        // paymentToken, payment, paymentReceiver
        // We use address(0) for optional params (no delegatecall setup, no fallback handler,
        // no payment)
        ISafe(m2Safe)
            .setup(
                owners,
                1, // threshold
                address(0), // to
                "", // data
                address(0), // fallbackHandler
                address(0), // paymentToken
                0, // payment
                payable(address(0)) // paymentReceiver
            );

        // Step 3: Deploy and configure modules for Model A
        if (custodyModel == uint8(CustodyModel.MODEL_A)) {
            _deployModules(m2Safe, salt);
        }
        // Model B: user-custodial, no automatic module setup

        // Step 4: Update tracking
        _deployedSafes[tenantId].push(m2Safe);
        unchecked {
            deploymentNonce[tenantId] = nonce + 1;
        }

        // Step 5: Auto-register in TenantRegistry
        registry.registerUser(tenantId, m2Safe);

        emit SafeDeployed(tenantId, userSigner, m2Safe, custodyModel);

        return m2Safe;
    }

    // ============ Internal Functions ============

    /// @notice Deploy all modules for Model A and enable them on the Safe
    /// @dev Deploys SpendSettler via CREATE2, Roles Module and Delay Module via EIP-1167 clone.
    ///      Roles/Delay deployment is skipped if their implementation is address(0).
    /// @param m2Safe The Safe to attach modules to
    /// @param salt The salt for deterministic deployment
    function _deployModules(address m2Safe, bytes32 salt) internal {
        // (a) Deploy SpendSettler via CREATE2 with constructor args
        bytes memory bytecode = abi.encodePacked(
            type(SpendSettler).creationCode,
            abi.encode(m2Safe, m2Safe, settler, issuerSafe, usdc) // avatar, owner, settler, issuerSafe, usdc
        );

        address spendSettlerAddr;
        assembly {
            spendSettlerAddr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (spendSettlerAddr == address(0)) revert DeploymentFailed();

        // Enable SpendSettler as module on the Safe
        ISafe(m2Safe).enableModule(spendSettlerAddr);
        safeToSettler[m2Safe] = spendSettlerAddr;

        // (b) Deploy Roles Module via EIP-1167 clone (if impl is set)
        if (rolesModuleImplementation != address(0)) {
            bytes32 rolesSalt = keccak256(abi.encodePacked(salt, "roles"));
            address rolesModule = Clones.cloneDeterministic(rolesModuleImplementation, rolesSalt);
            if (rolesModule == address(0)) revert DeploymentFailed();

            // Initialize the Roles Module clone: owner=Safe, avatar=Safe, target=Safe
            (bool success,) =
                rolesModule.call(abi.encodeWithSignature("setUp(address,address,address)", m2Safe, m2Safe, m2Safe));
            if (!success) revert DeploymentFailed();

            ISafe(m2Safe).enableModule(rolesModule);
            safeToRoles[m2Safe] = rolesModule;

            emit RolesModuleDeployed(m2Safe, rolesModule);
        }

        // (c) Deploy Delay Module via EIP-1167 clone (if impl is set)
        if (delayModuleImplementation != address(0)) {
            bytes32 delaySalt = keccak256(abi.encodePacked(salt, "delay"));
            address delayModule = Clones.cloneDeterministic(delayModuleImplementation, delaySalt);
            if (delayModule == address(0)) revert DeploymentFailed();

            // Initialize the Delay Module clone: owner=Safe, avatar=Safe, target=Safe
            (bool success,) =
                delayModule.call(abi.encodeWithSignature("setUp(address,address,address)", m2Safe, m2Safe, m2Safe));
            if (!success) revert DeploymentFailed();

            ISafe(m2Safe).enableModule(delayModule);
            safeToDelay[m2Safe] = delayModule;

            emit DelayModuleDeployed(m2Safe, delayModule);
        }
    }

    // ============ View Functions ============

    /// @notice Get all Safes deployed for a tenant
    /// @param tenantId The tenant identifier
    /// @return safes Array of deployed Safe addresses
    function getDeployedSafes(bytes32 tenantId) external view returns (address[] memory) {
        return _deployedSafes[tenantId];
    }

    /// @notice Get the number of Safes deployed for a tenant
    /// @param tenantId The tenant identifier
    /// @return count Number of deployed Safes
    function getDeployedSafeCount(bytes32 tenantId) external view returns (uint256) {
        return _deployedSafes[tenantId].length;
    }

    /// @notice Get the current deployment nonce for a tenant
    /// @param tenantId The tenant identifier
    /// @return nonce The current nonce
    function getNonce(bytes32 tenantId) external view returns (uint256) {
        return deploymentNonce[tenantId];
    }

    /// @notice Get the SpendSettler module for a deployed Safe
    /// @param m2Safe The Safe address
    /// @return settlerModule The SpendSettler address (address(0) if none)
    function getSettlerForSafe(address m2Safe) external view returns (address) {
        return safeToSettler[m2Safe];
    }

    /// @notice Get the Roles Module for a deployed Safe
    /// @param m2Safe The Safe address
    /// @return rolesModule The Roles Module address (address(0) if none)
    function getRolesForSafe(address m2Safe) external view returns (address) {
        return safeToRoles[m2Safe];
    }

    /// @notice Get the Delay Module for a deployed Safe
    /// @param m2Safe The Safe address
    /// @return delayModule The Delay Module address (address(0) if none)
    function getDelayForSafe(address m2Safe) external view returns (address) {
        return safeToDelay[m2Safe];
    }
}
