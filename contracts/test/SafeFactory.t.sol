// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {SafeFactory} from "../src/SafeFactory.sol";
import {ISafeFactory} from "../src/interfaces/ISafeFactory.sol";
import {TenantRegistry} from "../src/TenantRegistry.sol";
import {ITenantRegistry} from "../src/interfaces/ITenantRegistry.sol";
import {SpendSettler} from "../src/SpendSettler.sol";
import {MockSafeSingleton} from "./mocks/MockSafeSingleton.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockRolesModule} from "./mocks/MockRolesModule.sol";
import {MockDelayModule} from "./mocks/MockDelayModule.sol";

contract SafeFactoryTest is Test {
    SafeFactory public factory;
    TenantRegistry public registry;
    MockSafeSingleton public safeSingleton;
    MockERC20 public usdc;
    MockRolesModule public rolesSingleton;
    MockDelayModule public delaySingleton;

    address public owner = address(0xAA);
    address public settlerEOA = address(0xBB);
    address public issuerSafe = address(0xCC);
    address public userSigner = address(0xDD);
    address public attacker = address(0xEE);

    bytes32 public tenantId = keccak256("tenant-001");
    bytes32 public tenantId2 = keccak256("tenant-002");

    function setUp() public {
        safeSingleton = new MockSafeSingleton();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        rolesSingleton = new MockRolesModule();
        delaySingleton = new MockDelayModule();

        vm.startPrank(owner);

        // Deploy registry
        registry = new TenantRegistry(owner);

        // Deploy factory with Roles + Delay module implementations
        factory = new SafeFactory(
            owner,
            address(safeSingleton),
            address(0x01), // spendSettlerImplementation (placeholder, not used for CREATE2 path)
            settlerEOA,
            issuerSafe,
            address(usdc),
            address(rolesSingleton),
            address(delaySingleton)
        );

        // Wire up registry <-> factory
        factory.setRegistry(address(registry));
        registry.setFactory(address(factory));

        // Register a tenant
        registry.registerTenant(tenantId, address(0x9999));

        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_constructor_setsStateCorrectly() public view {
        assertEq(factory.owner(), owner);
        assertEq(factory.safeImplementation(), address(safeSingleton));
        assertEq(factory.settler(), settlerEOA);
        assertEq(factory.issuerSafe(), issuerSafe);
        assertEq(factory.usdc(), address(usdc));
        assertEq(factory.rolesModuleImplementation(), address(rolesSingleton));
        assertEq(factory.delayModuleImplementation(), address(delaySingleton));
    }

    function test_constructor_acceptsZeroRolesAndDelayImpl() public {
        // Backwards compat: address(0) for roles/delay is valid (skips deployment)
        SafeFactory f = new SafeFactory(
            owner, address(safeSingleton), address(0x01), settlerEOA, issuerSafe, address(usdc), address(0), address(0)
        );
        assertEq(f.rolesModuleImplementation(), address(0));
        assertEq(f.delayModuleImplementation(), address(0));
    }

    function test_constructor_revertsOnZeroSafeImpl() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        new SafeFactory(owner, address(0), address(0x01), settlerEOA, issuerSafe, address(usdc), address(0), address(0));
    }

    function test_constructor_revertsOnZeroSettlerImpl() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        new SafeFactory(
            owner, address(safeSingleton), address(0), settlerEOA, issuerSafe, address(usdc), address(0), address(0)
        );
    }

    function test_constructor_revertsOnZeroSettler() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        new SafeFactory(
            owner, address(safeSingleton), address(0x01), address(0), issuerSafe, address(usdc), address(0), address(0)
        );
    }

    function test_constructor_revertsOnZeroIssuerSafe() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        new SafeFactory(
            owner, address(safeSingleton), address(0x01), settlerEOA, address(0), address(usdc), address(0), address(0)
        );
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        new SafeFactory(
            owner, address(safeSingleton), address(0x01), settlerEOA, issuerSafe, address(0), address(0), address(0)
        );
    }

    // ============ Configuration Tests ============

    function test_setRegistry_updatesRegistry() public {
        address newRegistry = address(0xFF);
        vm.prank(owner);
        factory.setRegistry(newRegistry);
        assertEq(address(factory.registry()), newRegistry);
    }

    function test_setRegistry_emitsEvent() public {
        address newRegistry = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.RegistryUpdated(address(registry), newRegistry);

        vm.prank(owner);
        factory.setRegistry(newRegistry);
    }

    function test_setRegistry_revertsOnZero() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.setRegistry(address(0));
    }

    function test_setRegistry_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        factory.setRegistry(address(0xFF));
    }

    function test_setSpendSettlerImplementation_updates() public {
        address newImpl = address(0xFF);
        vm.prank(owner);
        factory.setSpendSettlerImplementation(newImpl);
        assertEq(factory.spendSettlerImplementation(), newImpl);
    }

    function test_setSpendSettlerImplementation_emitsEvent() public {
        address newImpl = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.SpendSettlerImplementationUpdated(address(0x01), newImpl);

        vm.prank(owner);
        factory.setSpendSettlerImplementation(newImpl);
    }

    function test_setSpendSettlerImplementation_revertsOnZero() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.setSpendSettlerImplementation(address(0));
    }

    function test_setIssuerSafe_updates() public {
        address newIssuer = address(0xFF);
        vm.prank(owner);
        factory.setIssuerSafe(newIssuer);
        assertEq(factory.issuerSafe(), newIssuer);
    }

    function test_setIssuerSafe_emitsEvent() public {
        address newIssuer = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.IssuerSafeUpdated(issuerSafe, newIssuer);

        vm.prank(owner);
        factory.setIssuerSafe(newIssuer);
    }

    function test_setIssuerSafe_revertsOnZero() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.setIssuerSafe(address(0));
    }

    function test_setUsdc_updates() public {
        address newUsdc = address(0xFF);
        vm.prank(owner);
        factory.setUsdc(newUsdc);
        assertEq(factory.usdc(), newUsdc);
    }

    function test_setUsdc_emitsEvent() public {
        address newUsdc = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.UsdcUpdated(address(usdc), newUsdc);

        vm.prank(owner);
        factory.setUsdc(newUsdc);
    }

    function test_setUsdc_revertsOnZero() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.setUsdc(address(0));
    }

    // ============ Safe Deployment Tests (Model B - no SpendSettler) ============

    function test_deploySafe_modelB_deploysSafe() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertTrue(m2Safe != address(0));
        assertTrue(m2Safe.code.length > 0);
    }

    function test_deploySafe_modelB_configuresOwner() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        MockSafeSingleton safe = MockSafeSingleton(payable(m2Safe));
        address[] memory owners = safe.getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], userSigner);
        assertEq(safe.getThreshold(), 1);
    }

    function test_deploySafe_modelB_emitsEvent() public {
        vm.expectEmit(true, true, false, false);
        // We don't know the Safe address yet, so we check tenantId and userSigner (indexed).
        // Model B has no modules, so all module addresses are address(0).
        emit ISafeFactory.SafeDeployed(
            tenantId,
            userSigner,
            address(0),
            uint8(ISafeFactory.CustodyModel.MODEL_B),
            address(0),
            address(0),
            address(0)
        );

        vm.prank(owner);
        factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));
    }

    function test_deploySafe_modelB_registersInRegistry() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertTrue(registry.isRegisteredUser(tenantId, m2Safe));
        assertEq(registry.getTenantForSafe(m2Safe), tenantId);
    }

    function test_deploySafe_modelB_noModules() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertEq(factory.getSettlerForSafe(m2Safe), address(0));
        assertEq(factory.getRolesForSafe(m2Safe), address(0));
        assertEq(factory.getDelayForSafe(m2Safe), address(0));
    }

    function test_deploySafe_modelB_incrementsNonce() public {
        assertEq(factory.getNonce(tenantId), 0);

        vm.prank(owner);
        factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertEq(factory.getNonce(tenantId), 1);
    }

    function test_deploySafe_modelB_tracksDeployment() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        address[] memory safes = factory.getDeployedSafes(tenantId);
        assertEq(safes.length, 1);
        assertEq(safes[0], m2Safe);
        assertEq(factory.getDeployedSafeCount(tenantId), 1);
    }

    // ============ Safe Deployment Tests (Model A - with SpendSettler) ============

    function test_deploySafe_modelA_deploysWithSettler() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        assertTrue(m2Safe != address(0));

        // SpendSettler should be deployed and tracked
        address settlerAddr = factory.getSettlerForSafe(m2Safe);
        assertTrue(settlerAddr != address(0));
        assertTrue(settlerAddr.code.length > 0);
    }

    function test_deploySafe_modelA_settlerConfiguredCorrectly() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address settlerAddr = factory.getSettlerForSafe(m2Safe);
        SpendSettler spendSettler = SpendSettler(settlerAddr);

        assertEq(spendSettler.avatar(), m2Safe);
        assertEq(spendSettler.target(), m2Safe);
        assertEq(spendSettler.owner(), m2Safe);
        assertEq(spendSettler.settler(), settlerEOA);
        assertEq(spendSettler.issuerSafe(), issuerSafe);
        assertEq(spendSettler.usdc(), address(usdc));
    }

    function test_deploySafe_modelA_settlerEnabledAsModule() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address settlerAddr = factory.getSettlerForSafe(m2Safe);
        MockSafeSingleton safe = MockSafeSingleton(payable(m2Safe));
        assertTrue(safe.isModuleEnabled(settlerAddr));
    }

    function test_deploySafe_modelA_registersInRegistry() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        assertTrue(registry.isRegisteredUser(tenantId, m2Safe));
    }

    // ============ CREATE2 Determinism Tests ============

    function test_computeSafeAddress_matchesDeployment() public {
        uint256 nonce = factory.getNonce(tenantId);
        address predicted = factory.computeSafeAddress(tenantId, userSigner, nonce);

        vm.prank(owner);
        address actual = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertEq(predicted, actual);
    }

    function test_computeSafeAddress_differentTenantsGetDifferentAddresses() public {
        vm.prank(owner);
        registry.registerTenant(tenantId2, address(0x8888));

        address addr1 = factory.computeSafeAddress(tenantId, userSigner, 0);
        address addr2 = factory.computeSafeAddress(tenantId2, userSigner, 0);

        assertTrue(addr1 != addr2);
    }

    function test_computeSafeAddress_differentSignersGetDifferentAddresses() public {
        address signer2 = address(0xF1);
        address addr1 = factory.computeSafeAddress(tenantId, userSigner, 0);
        address addr2 = factory.computeSafeAddress(tenantId, signer2, 0);

        assertTrue(addr1 != addr2);
    }

    function test_computeSafeAddress_differentNoncesGetDifferentAddresses() public {
        address addr1 = factory.computeSafeAddress(tenantId, userSigner, 0);
        address addr2 = factory.computeSafeAddress(tenantId, userSigner, 1);

        assertTrue(addr1 != addr2);
    }

    function test_computeSalt_deterministic() public view {
        bytes32 tenantA = keccak256("a");
        address signerA = address(0x01);
        bytes32 salt1 = factory.computeSalt(tenantA, signerA, 0);
        bytes32 salt2 = factory.computeSalt(tenantA, signerA, 0);
        assertEq(salt1, salt2);
    }

    // ============ Access Control Tests ============

    function test_deploySafe_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));
    }

    function test_deploySafe_revertsOnZeroTenantId() public {
        vm.expectRevert(SafeFactory.InvalidTenantId.selector);
        vm.prank(owner);
        factory.deploySafe(bytes32(0), userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));
    }

    function test_deploySafe_revertsOnZeroUserSigner() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.deploySafe(tenantId, address(0), uint8(ISafeFactory.CustodyModel.MODEL_A));
    }

    function test_deploySafe_revertsOnInvalidCustodyModel() public {
        vm.expectRevert(abi.encodeWithSelector(SafeFactory.InvalidCustodyModel.selector, uint8(2)));
        vm.prank(owner);
        factory.deploySafe(tenantId, userSigner, 2);
    }

    function test_deploySafe_revertsWithoutRegistry() public {
        vm.startPrank(owner);
        SafeFactory factoryNoRegistry = new SafeFactory(
            owner, address(safeSingleton), address(0x01), settlerEOA, issuerSafe, address(usdc), address(0), address(0)
        );
        vm.stopPrank();

        vm.expectRevert(SafeFactory.RegistryNotSet.selector);
        vm.prank(owner);
        factoryNoRegistry.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));
    }

    // ============ Multiple Deployments Tests ============

    function test_deploySafe_multipleForSameTenant() public {
        vm.startPrank(owner);
        address safe1 = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));
        address safe2 = factory.deploySafe(tenantId, address(0xF1), uint8(ISafeFactory.CustodyModel.MODEL_B));
        address safe3 = factory.deploySafe(tenantId, address(0xF2), uint8(ISafeFactory.CustodyModel.MODEL_A));
        vm.stopPrank();

        assertTrue(safe1 != safe2);
        assertTrue(safe2 != safe3);
        assertEq(factory.getDeployedSafeCount(tenantId), 3);
        assertEq(factory.getNonce(tenantId), 3);

        address[] memory safes = factory.getDeployedSafes(tenantId);
        assertEq(safes.length, 3);
        assertEq(safes[0], safe1);
        assertEq(safes[1], safe2);
        assertEq(safes[2], safe3);
    }

    function test_deploySafe_differentTenants() public {
        vm.startPrank(owner);
        registry.registerTenant(tenantId2, address(0x8888));

        address safe1 = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));
        address safe2 = factory.deploySafe(tenantId2, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));
        vm.stopPrank();

        assertTrue(safe1 != safe2);
        assertEq(factory.getDeployedSafeCount(tenantId), 1);
        assertEq(factory.getDeployedSafeCount(tenantId2), 1);
    }

    // ============ View Function Tests ============

    function test_getDeployedSafes_emptyForNewTenant() public view {
        address[] memory safes = factory.getDeployedSafes(tenantId);
        assertEq(safes.length, 0);
    }

    function test_getNonce_startsAtZero() public view {
        assertEq(factory.getNonce(tenantId), 0);
    }

    function test_getSettlerForSafe_returnsZeroForUnknown() public view {
        assertEq(factory.getSettlerForSafe(address(0x9999)), address(0));
    }

    function test_getRolesForSafe_returnsZeroForUnknown() public view {
        assertEq(factory.getRolesForSafe(address(0x9999)), address(0));
    }

    function test_getDelayForSafe_returnsZeroForUnknown() public view {
        assertEq(factory.getDelayForSafe(address(0x9999)), address(0));
    }

    // ============ Fuzz Tests ============

    function testFuzz_computeSalt_uniqueForDifferentInputs(bytes32 _tenantId, address _userSigner, uint256 _nonce)
        public
        view
    {
        bytes32 salt = factory.computeSalt(_tenantId, _userSigner, _nonce);
        // Salt should be non-zero for non-zero inputs
        if (_tenantId != bytes32(0) || _userSigner != address(0) || _nonce != 0) {
            assertTrue(salt != bytes32(0) || (_tenantId == bytes32(0) && _userSigner == address(0) && _nonce == 0));
        }
    }

    function testFuzz_deploySafe_arbitrarySigners(address signer) public {
        vm.assume(signer != address(0));
        // Avoid precompile addresses that might have unexpected behavior
        vm.assume(uint160(signer) > 0xFF);

        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, signer, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertTrue(m2Safe != address(0));
        assertTrue(registry.isRegisteredUser(tenantId, m2Safe));
    }

    // ============ Roles Module + Delay Module Tests (Model A) ============

    function test_deploySafe_modelA_deploysRolesModule() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address rolesAddr = factory.getRolesForSafe(m2Safe);
        assertTrue(rolesAddr != address(0));
        assertTrue(rolesAddr.code.length > 0);

        // Verify the Roles Module is initialized with the Safe as owner/avatar/target
        MockRolesModule roles = MockRolesModule(rolesAddr);
        assertTrue(roles.initialized());
        assertEq(roles.owner(), m2Safe);
        assertEq(roles.avatar(), m2Safe);
        assertEq(roles.target(), m2Safe);
    }

    function test_deploySafe_modelA_deploysDelayModule() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address delayAddr = factory.getDelayForSafe(m2Safe);
        assertTrue(delayAddr != address(0));
        assertTrue(delayAddr.code.length > 0);

        // Verify the Delay Module is initialized with the Safe as owner/avatar/target
        MockDelayModule delayMod = MockDelayModule(delayAddr);
        assertTrue(delayMod.initialized());
        assertEq(delayMod.owner(), m2Safe);
        assertEq(delayMod.avatar(), m2Safe);
        assertEq(delayMod.target(), m2Safe);
    }

    function test_deploySafe_modelA_rolesEnabledAsModule() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address rolesAddr = factory.getRolesForSafe(m2Safe);
        MockSafeSingleton safe = MockSafeSingleton(payable(m2Safe));
        assertTrue(safe.isModuleEnabled(rolesAddr));
    }

    function test_deploySafe_modelA_delayEnabledAsModule() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        address delayAddr = factory.getDelayForSafe(m2Safe);
        MockSafeSingleton safe = MockSafeSingleton(payable(m2Safe));
        assertTrue(safe.isModuleEnabled(delayAddr));
    }

    function test_deploySafe_modelA_emitsRolesModuleDeployed() public {
        vm.recordLogs();

        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found = false;
        bytes32 expectedTopic = keccak256("RolesModuleDeployed(address,address)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == expectedTopic) {
                // topic1 is the m2Safe (indexed)
                assertEq(address(uint160(uint256(entries[i].topics[1]))), m2Safe);
                found = true;
                break;
            }
        }
        assertTrue(found, "RolesModuleDeployed event not found");
    }

    function test_deploySafe_modelA_emitsDelayModuleDeployed() public {
        vm.recordLogs();

        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found = false;
        bytes32 expectedTopic = keccak256("DelayModuleDeployed(address,address)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == expectedTopic) {
                assertEq(address(uint160(uint256(entries[i].topics[1]))), m2Safe);
                found = true;
                break;
            }
        }
        assertTrue(found, "DelayModuleDeployed event not found");
    }

    function test_deploySafe_modelA_allThreeModulesEnabled() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        MockSafeSingleton safe = MockSafeSingleton(payable(m2Safe));

        address settlerAddr = factory.getSettlerForSafe(m2Safe);
        address rolesAddr = factory.getRolesForSafe(m2Safe);
        address delayAddr = factory.getDelayForSafe(m2Safe);

        assertTrue(settlerAddr != address(0));
        assertTrue(rolesAddr != address(0));
        assertTrue(delayAddr != address(0));

        // All three are distinct addresses
        assertTrue(settlerAddr != rolesAddr);
        assertTrue(settlerAddr != delayAddr);
        assertTrue(rolesAddr != delayAddr);

        // All three are enabled as modules
        assertTrue(safe.isModuleEnabled(settlerAddr));
        assertTrue(safe.isModuleEnabled(rolesAddr));
        assertTrue(safe.isModuleEnabled(delayAddr));
    }

    function test_deploySafe_modelA_skipsRolesIfImplZero() public {
        vm.startPrank(owner);
        SafeFactory factoryNoRoles = new SafeFactory(
            owner,
            address(safeSingleton),
            address(0x01),
            settlerEOA,
            issuerSafe,
            address(usdc),
            address(0), // no roles impl
            address(delaySingleton)
        );
        factoryNoRoles.setRegistry(address(registry));
        vm.stopPrank();

        // Need to authorize this factory in the registry
        vm.prank(owner);
        registry.setFactory(address(factoryNoRoles));

        vm.prank(owner);
        address m2Safe = factoryNoRoles.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        // SpendSettler deployed, Delay deployed, Roles skipped
        assertTrue(factoryNoRoles.getSettlerForSafe(m2Safe) != address(0));
        assertEq(factoryNoRoles.getRolesForSafe(m2Safe), address(0));
        assertTrue(factoryNoRoles.getDelayForSafe(m2Safe) != address(0));
    }

    function test_deploySafe_modelA_skipsDelayIfImplZero() public {
        vm.startPrank(owner);
        SafeFactory factoryNoDelay = new SafeFactory(
            owner,
            address(safeSingleton),
            address(0x01),
            settlerEOA,
            issuerSafe,
            address(usdc),
            address(rolesSingleton),
            address(0) // no delay impl
        );
        factoryNoDelay.setRegistry(address(registry));
        vm.stopPrank();

        vm.prank(owner);
        registry.setFactory(address(factoryNoDelay));

        vm.prank(owner);
        address m2Safe = factoryNoDelay.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_A));

        // SpendSettler deployed, Roles deployed, Delay skipped
        assertTrue(factoryNoDelay.getSettlerForSafe(m2Safe) != address(0));
        assertTrue(factoryNoDelay.getRolesForSafe(m2Safe) != address(0));
        assertEq(factoryNoDelay.getDelayForSafe(m2Safe), address(0));
    }

    function test_deploySafe_modelB_noRolesOrDelay() public {
        vm.prank(owner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        assertEq(factory.getSettlerForSafe(m2Safe), address(0));
        assertEq(factory.getRolesForSafe(m2Safe), address(0));
        assertEq(factory.getDelayForSafe(m2Safe), address(0));
    }

    // ============ New Setter Tests ============

    function test_setRolesModuleImplementation_updates() public {
        address newImpl = address(0xFF);
        vm.prank(owner);
        factory.setRolesModuleImplementation(newImpl);
        assertEq(factory.rolesModuleImplementation(), newImpl);
    }

    function test_setRolesModuleImplementation_emitsEvent() public {
        address newImpl = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.RolesModuleImplementationUpdated(address(rolesSingleton), newImpl);

        vm.prank(owner);
        factory.setRolesModuleImplementation(newImpl);
    }

    function test_setRolesModuleImplementation_allowsZero() public {
        // Setting to zero disables Roles deployment
        vm.prank(owner);
        factory.setRolesModuleImplementation(address(0));
        assertEq(factory.rolesModuleImplementation(), address(0));
    }

    function test_setRolesModuleImplementation_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        factory.setRolesModuleImplementation(address(0xFF));
    }

    function test_setDelayModuleImplementation_updates() public {
        address newImpl = address(0xFF);
        vm.prank(owner);
        factory.setDelayModuleImplementation(newImpl);
        assertEq(factory.delayModuleImplementation(), newImpl);
    }

    function test_setDelayModuleImplementation_emitsEvent() public {
        address newImpl = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.DelayModuleImplementationUpdated(address(delaySingleton), newImpl);

        vm.prank(owner);
        factory.setDelayModuleImplementation(newImpl);
    }

    function test_setDelayModuleImplementation_allowsZero() public {
        vm.prank(owner);
        factory.setDelayModuleImplementation(address(0));
        assertEq(factory.delayModuleImplementation(), address(0));
    }

    function test_setDelayModuleImplementation_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        factory.setDelayModuleImplementation(address(0xFF));
    }

    function test_setM1TreasuryAddress_updates() public {
        address treasury = address(0xFF);
        vm.prank(owner);
        factory.setM1TreasuryAddress(treasury);
        assertEq(factory.m1TreasuryAddress(), treasury);
    }

    function test_setM1TreasuryAddress_emitsEvent() public {
        address treasury = address(0xFF);
        vm.expectEmit(true, true, false, false);
        emit ISafeFactory.M1TreasuryAddressUpdated(address(0), treasury);

        vm.prank(owner);
        factory.setM1TreasuryAddress(treasury);
    }

    function test_setM1TreasuryAddress_revertsOnZero() public {
        vm.expectRevert(SafeFactory.InvalidAddress.selector);
        vm.prank(owner);
        factory.setM1TreasuryAddress(address(0));
    }

    function test_setM1TreasuryAddress_revertsForNonOwner() public {
        vm.expectRevert();
        vm.prank(attacker);
        factory.setM1TreasuryAddress(address(0xFF));
    }

    // ============ Ownership Transfer Tests ============

    function test_transferOwnership() public {
        address newOwner = address(0x99);
        vm.prank(owner);
        factory.transferOwnership(newOwner);
        assertEq(factory.owner(), newOwner);

        // Old owner can no longer deploy
        vm.expectRevert();
        vm.prank(owner);
        factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));

        // New owner can deploy (but we need to set up registry auth first)
        vm.prank(owner);
        registry.setFactory(address(factory)); // re-authorize if needed

        vm.prank(newOwner);
        address m2Safe = factory.deploySafe(tenantId, userSigner, uint8(ISafeFactory.CustodyModel.MODEL_B));
        assertTrue(m2Safe != address(0));
    }
}
