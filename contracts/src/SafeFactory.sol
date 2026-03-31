// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ISafeFactory} from "./interfaces/ISafeFactory.sol";
import {ITenantRegistry} from "./interfaces/ITenantRegistry.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {SpendSettler} from "./SpendSettler.sol";
import {ModuleSetupHelper} from "./ModuleSetupHelper.sol";

/// @title SafeFactory
/// @notice Factory that deploys a fully configured M2 Safe bundle in a single transaction
///         using CREATE2 for deterministic addresses. Deploys Safe proxy + SpendSettler
///         module and auto-registers in the TenantRegistry.
/// @dev Uses EIP-1167 minimal proxy clones for Safe deployment to reduce gas costs.
///      SpendSettler is deployed via CREATE2 with full bytecode since it requires
///      constructor-based initialization (Module base contract pattern).
///      Gas target: <500K on Base.
contract SafeFactory is ISafeFactory, Ownable2Step {
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

    /// @notice ModuleSetupHelper that the Safe delegatecalls during setup()
    address public moduleSetupHelper;

    // ============ Errors ============

    error InvalidAddress();
    error InvalidCustodyModel(uint8 model);
    error RegistryNotSet();
    error DeploymentFailed();
    error SafeSetupFailed();
    error InvalidTenantId();
    error ModuleSetupHelperNotSet();

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

    /// @notice Update the settler address for future deployments
    /// @param _settler The new settler address
    function setSettler(address _settler) external onlyOwner {
        if (_settler == address(0)) revert InvalidAddress();
        address oldSettler = settler;
        settler = _settler;
        emit SettlerUpdated(oldSettler, _settler);
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

    /// @notice Set the ModuleSetupHelper address
    /// @param _helper The new helper address
    function setModuleSetupHelper(address _helper) external onlyOwner {
        if (_helper == address(0)) revert InvalidAddress();
        moduleSetupHelper = _helper;
    }

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

        address settlerAddr;
        address rolesAddr;
        address delayAddr;

        if (custodyModel == uint8(CustodyModel.MODEL_A)) {
            if (moduleSetupHelper == address(0)) revert ModuleSetupHelperNotSet();

            // Deploy module contracts BEFORE Safe.setup() so we know their addresses
            (settlerAddr, rolesAddr, delayAddr) = _deployModuleContracts(m2Safe, salt);

            // Build arrays for the ModuleSetupHelper delegatecall
            (address setupTo, bytes memory setupData) = _buildModuleSetupData(m2Safe, settlerAddr, rolesAddr, delayAddr);

            // Safe.setup() with to/data — the Safe delegatecalls the helper,
            // which calls this.enableModule() (authorized because this == Safe)
            // and initializes Zodiac clones via setUp(bytes).
            ISafe(m2Safe)
                .setup(
                    owners,
                    1, // threshold
                    setupTo, // delegatecall target: ModuleSetupHelper
                    setupData, // enableModules(...)
                    address(0), // fallbackHandler
                    address(0), // paymentToken
                    0, // payment
                    payable(address(0)) // paymentReceiver
                );

            // Track module mappings
            safeToSettler[m2Safe] = settlerAddr;
            if (rolesAddr != address(0)) {
                safeToRoles[m2Safe] = rolesAddr;
                emit RolesModuleDeployed(m2Safe, rolesAddr);
            }
            if (delayAddr != address(0)) {
                safeToDelay[m2Safe] = delayAddr;
                emit DelayModuleDeployed(m2Safe, delayAddr);
            }
        } else {
            // Model B: user-custodial, no automatic module setup
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
        }

        // Update tracking
        _deployedSafes[tenantId].push(m2Safe);
        unchecked {
            deploymentNonce[tenantId] = nonce + 1;
        }

        // Auto-register in TenantRegistry
        registry.registerUser(tenantId, m2Safe);

        emit SafeDeployed(tenantId, userSigner, m2Safe, custodyModel, settlerAddr, rolesAddr, delayAddr);

        return m2Safe;
    }

    // ============ Internal Functions ============

    /// @notice Deploy all module contracts for Model A (no enableModule/setUp calls).
    /// @dev Deploys SpendSettler via CREATE2, Roles and Delay via EIP-1167 clone.
    ///      Module enabling and Zodiac initialization happen inside the Safe's
    ///      setup() delegatecall to the ModuleSetupHelper.
    ///      Modules are deployed and initialized atomically within deploySafe() to prevent
    ///      front-running of Zodiac setUp(). Clones don't exist before this tx, so their
    ///      deterministic addresses cannot be initialized by an attacker.
    /// @param m2Safe The Safe the modules will be attached to
    /// @param salt The salt for deterministic deployment
    function _deployModuleContracts(address m2Safe, bytes32 salt)
        internal
        returns (address _settler, address _roles, address _delay)
    {
        // (a) Deploy SpendSettler via CREATE2 with constructor args
        bytes memory bytecode =
            abi.encodePacked(type(SpendSettler).creationCode, abi.encode(m2Safe, owner(), settler, issuerSafe, usdc));

        address spendSettlerAddr;
        assembly {
            spendSettlerAddr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (spendSettlerAddr == address(0)) revert DeploymentFailed();
        _settler = spendSettlerAddr;

        // (b) Deploy Roles Module clone (if impl is set)
        if (rolesModuleImplementation != address(0)) {
            bytes32 rolesSalt = keccak256(abi.encodePacked(salt, "roles"));
            address rolesModule = Clones.cloneDeterministic(rolesModuleImplementation, rolesSalt);
            if (rolesModule == address(0)) revert DeploymentFailed();
            _roles = rolesModule;
        }

        // (c) Deploy Delay Module clone (if impl is set)
        if (delayModuleImplementation != address(0)) {
            bytes32 delaySalt = keccak256(abi.encodePacked(salt, "delay"));
            address delayModule = Clones.cloneDeterministic(delayModuleImplementation, delaySalt);
            if (delayModule == address(0)) revert DeploymentFailed();
            _delay = delayModule;
        }
    }

    /// @notice Build the to/data params for Safe.setup() delegatecall to ModuleSetupHelper
    /// @param m2Safe The Safe address (used for Zodiac init data)
    /// @param settlerAddr The SpendSettler address to enable
    /// @param rolesAddr The Roles Module address (address(0) to skip)
    /// @param delayAddr The Delay Module address (address(0) to skip)
    /// @return setupTo The delegatecall target (ModuleSetupHelper)
    /// @return setupData The encoded enableModules(...) call
    function _buildModuleSetupData(address m2Safe, address settlerAddr, address rolesAddr, address delayAddr)
        internal
        view
        returns (address setupTo, bytes memory setupData)
    {
        // Count how many modules to enable and how many need Zodiac init
        uint256 moduleCount = 1; // SpendSettler always
        uint256 zodiacCount = 0;
        if (rolesAddr != address(0)) {
            moduleCount++;
            zodiacCount++;
        }
        if (delayAddr != address(0)) {
            moduleCount++;
            zodiacCount++;
        }

        // Build modules array (all modules to enableModule on)
        address[] memory modules = new address[](moduleCount);
        modules[0] = settlerAddr;
        uint256 idx = 1;
        if (rolesAddr != address(0)) {
            modules[idx++] = rolesAddr;
        }
        if (delayAddr != address(0)) {
            modules[idx++] = delayAddr;
        }

        // Build Zodiac arrays (modules that need setUp(bytes) initialization)
        address[] memory zodiacModules = new address[](zodiacCount);
        bytes[] memory zodiacInitData = new bytes[](zodiacCount);
        uint256 zIdx = 0;
        if (rolesAddr != address(0)) {
            zodiacModules[zIdx] = rolesAddr;
            // Zodiac standard: setUp(bytes) where bytes = abi.encode(owner, avatar, target)
            zodiacInitData[zIdx] = abi.encode(m2Safe, m2Safe, m2Safe);
            zIdx++;
        }
        if (delayAddr != address(0)) {
            zodiacModules[zIdx] = delayAddr;
            zodiacInitData[zIdx] = abi.encode(m2Safe, m2Safe, m2Safe);
            zIdx++;
        }

        setupTo = moduleSetupHelper;
        setupData =
            abi.encodeWithSelector(ModuleSetupHelper.enableModules.selector, modules, zodiacModules, zodiacInitData);
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
