// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {ModuleSetupHelper} from "../src/ModuleSetupHelper.sol";
import {TenantRegistry} from "../src/TenantRegistry.sol";
import {SafeFactory} from "../src/SafeFactory.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {SpendSettler} from "../src/SpendSettler.sol";

/// @title DeployAll
/// @notice Master deployment script for the entire MultiSubs infrastructure.
///         Deploys contracts in the correct dependency order and writes
///         deployed addresses to `deployments/{chainId}.json`.
///
/// @dev Deployment order:
///   Phase 1 — Core Infrastructure
///     1. ModuleSetupHelper (stateless, deploy once)
///     2. TenantRegistry (owner = deployer)
///     3. SpendSettler implementation (reference for factory)
///     4. SafeFactory (owner = deployer, wired to registry + helper)
///     5. Set SafeFactory as authorized factory on TenantRegistry
///
///   Phase 2 — M1 Treasury Modules
///     6. DeFiInteractor (avatar = M1_SAFE, owner = deployer, operator = YIELD_OPERATOR)
///     7. TreasuryVault (avatar = M1_SAFE, owner = deployer, operator = YIELD_OPERATOR, morphoVault, usdc)
///
///   Phase 3 — Configuration
///     8. Add Morpho vault to DeFiInteractor allowlist
///     9. Add Aave pool to DeFiInteractor allowlist (if configured)
///    10. Register initial tenant on TenantRegistry (if configured)
contract DeployAll is Script {
    // ── Deployed addresses ────────────────────────────────────────────────
    address public moduleSetupHelper;
    address public tenantRegistry;
    address public spendSettlerImpl;
    address public safeFactory;
    address public defiInteractor;
    address public treasuryVault;

    // ── Environment ───────────────────────────────────────────────────────
    address internal deployer;

    function run() external {
        // ── Read environment variables ────────────────────────────────────
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        deployer = vm.addr(deployerKey);

        address m1Safe = vm.envAddress("M1_SAFE_ADDRESS");
        address settlerAddr = vm.envAddress("SETTLER_ADDRESS");
        address yieldOperator = vm.envAddress("YIELD_OPERATOR_ADDRESS");
        address issuerSafe = vm.envAddress("PLATFORM_ISSUER_SAFE_ADDRESS");
        address usdcAddr = vm.envAddress("USDC_ADDRESS");
        address morphoVaultAddr = vm.envAddress("MORPHO_VAULT_ADDRESS");
        address safeSingleton = vm.envAddress("SAFE_SINGLETON_ADDRESS");
        address rolesModuleImpl = vm.envAddress("ROLES_MODULE_ADDRESS");
        address delayModuleImpl = vm.envAddress("DELAY_MODULE_ADDRESS");

        // Optional: Aave pool for DeFiInteractor allowlist
        address aavePool = vm.envOr("AAVE_POOL_ADDRESS", address(0));

        // Optional: initial tenant registration
        bytes32 initialTenantId = vm.envOr("INITIAL_TENANT_ID", bytes32(0));
        address initialTenantSafe = vm.envOr("INITIAL_TENANT_SAFE", address(0));

        _logConfig(
            m1Safe,
            settlerAddr,
            yieldOperator,
            issuerSafe,
            usdcAddr,
            morphoVaultAddr,
            safeSingleton,
            rolesModuleImpl,
            delayModuleImpl,
            aavePool
        );

        // ══════════════════════════════════════════════════════════════════
        // PHASE 1: Core Infrastructure
        // ══════════════════════════════════════════════════════════════════

        vm.startBroadcast(deployerKey);

        // 1. ModuleSetupHelper — stateless, deploy once
        console2.log("\n--- Phase 1: Core Infrastructure ---");
        ModuleSetupHelper helper = new ModuleSetupHelper();
        moduleSetupHelper = address(helper);
        console2.log("1. ModuleSetupHelper deployed:", moduleSetupHelper);

        // 2. TenantRegistry — owner = deployer
        TenantRegistry registry = new TenantRegistry(deployer);
        tenantRegistry = address(registry);
        console2.log("2. TenantRegistry deployed:", tenantRegistry);

        // 3. SpendSettler implementation — used by SafeFactory as reference
        //    Deploy with dummy params; this is a reference implementation only
        SpendSettler settlerImpl = new SpendSettler(
            address(1), // dummy avatar
            deployer, // owner
            settlerAddr,
            issuerSafe,
            usdcAddr
        );
        spendSettlerImpl = address(settlerImpl);
        console2.log("3. SpendSettler impl deployed:", spendSettlerImpl);

        // 4. SafeFactory — wired to registry, helper, settler impl, and singletons
        SafeFactory factory = new SafeFactory(
            deployer,
            safeSingleton,
            spendSettlerImpl,
            settlerAddr,
            issuerSafe,
            usdcAddr,
            rolesModuleImpl,
            delayModuleImpl
        );
        safeFactory = address(factory);
        console2.log("4. SafeFactory deployed:", safeFactory);

        // Wire registry and helper into factory
        factory.setRegistry(tenantRegistry);
        factory.setModuleSetupHelper(moduleSetupHelper);
        console2.log("   Factory -> Registry set");
        console2.log("   Factory -> ModuleSetupHelper set");

        // 5. Authorize factory on registry
        registry.setFactory(safeFactory);
        console2.log("5. TenantRegistry -> Factory authorized");

        // ══════════════════════════════════════════════════════════════════
        // PHASE 2: M1 Treasury Modules
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Phase 2: M1 Treasury Modules ---");

        // 6. DeFiInteractor — attached to M1 Safe
        DeFiInteractor defi = new DeFiInteractor(m1Safe, deployer, yieldOperator);
        defiInteractor = address(defi);
        console2.log("6. DeFiInteractor deployed:", defiInteractor);

        // 7. TreasuryVault — attached to M1 Safe
        TreasuryVault vault = new TreasuryVault(m1Safe, deployer, yieldOperator, morphoVaultAddr, usdcAddr);
        treasuryVault = address(vault);
        console2.log("7. TreasuryVault deployed:", treasuryVault);

        // Wire DeFiInteractor -> TreasuryVault for cross-module share desync protection
        defi.setTreasuryVault(treasuryVault);
        console2.log("   DeFiInteractor -> TreasuryVault wired");

        // ══════════════════════════════════════════════════════════════════
        // PHASE 3: Configuration
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Phase 3: Configuration ---");

        // 8. Add Morpho vault to DeFiInteractor allowlist
        defi.addAllowlistedVault(morphoVaultAddr);
        console2.log("8. Morpho vault allowlisted on DeFiInteractor");

        // 9. Add Aave pool to DeFiInteractor allowlist (if configured)
        if (aavePool != address(0)) {
            defi.addAllowlistedVault(aavePool);
            console2.log("9. Aave pool allowlisted on DeFiInteractor");
        } else {
            console2.log("9. Aave pool skipped (not configured)");
        }

        // 10. Register initial tenant on TenantRegistry (if configured)
        if (initialTenantId != bytes32(0) && initialTenantSafe != address(0)) {
            registry.registerTenant(initialTenantId, initialTenantSafe);
            console2.log("10. Initial tenant registered");
        } else {
            console2.log("10. Initial tenant registration skipped (not configured)");
        }

        vm.stopBroadcast();

        // ══════════════════════════════════════════════════════════════════
        // Write deployment JSON
        // ══════════════════════════════════════════════════════════════════

        _writeDeploymentJson();

        // ══════════════════════════════════════════════════════════════════
        // Summary
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n========================================");
        console2.log("  DEPLOYMENT COMPLETE");
        console2.log("========================================");
        console2.log("  Chain ID:           ", block.chainid);
        console2.log("  Deployer:           ", deployer);
        console2.log("  ModuleSetupHelper:  ", moduleSetupHelper);
        console2.log("  TenantRegistry:     ", tenantRegistry);
        console2.log("  SpendSettler impl:  ", spendSettlerImpl);
        console2.log("  SafeFactory:        ", safeFactory);
        console2.log("  DeFiInteractor:     ", defiInteractor);
        console2.log("  TreasuryVault:      ", treasuryVault);
        console2.log("========================================\n");

        console2.log("Post-deployment steps:");
        console2.log("  1. Enable DeFiInteractor as module on M1 Safe:");
        console2.log("     Safe.enableModule(", defiInteractor, ")");
        console2.log("  2. Enable TreasuryVault as module on M1 Safe:");
        console2.log("     Safe.enableModule(", treasuryVault, ")");
        console2.log("  3. Verify all contracts on Basescan:");
        console2.log("     forge script script/VerifyContracts.s.sol --rpc-url <rpc>");
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    function _logConfig(
        address m1Safe,
        address settlerAddr,
        address yieldOperator,
        address issuerSafe,
        address usdcAddr,
        address morphoVaultAddr,
        address safeSingleton,
        address rolesModuleImpl,
        address delayModuleImpl,
        address aavePool
    ) internal pure {
        console2.log("\n========================================");
        console2.log("  MultiSubs Full Deployment");
        console2.log("========================================");
        console2.log("  M1 Safe:           ", m1Safe);
        console2.log("  Settler:           ", settlerAddr);
        console2.log("  Yield Operator:    ", yieldOperator);
        console2.log("  Issuer Safe:       ", issuerSafe);
        console2.log("  USDC:              ", usdcAddr);
        console2.log("  Morpho Vault:      ", morphoVaultAddr);
        console2.log("  Safe Singleton:    ", safeSingleton);
        console2.log("  Roles Module Impl: ", rolesModuleImpl);
        console2.log("  Delay Module Impl: ", delayModuleImpl);
        console2.log("  Aave Pool:         ", aavePool);
        console2.log("========================================");
    }

    function _writeDeploymentJson() internal {
        string memory chainId = vm.toString(block.chainid);
        string memory obj = "deployment";

        vm.serializeAddress(obj, "moduleSetupHelper", moduleSetupHelper);
        vm.serializeAddress(obj, "tenantRegistry", tenantRegistry);
        vm.serializeAddress(obj, "spendSettlerImpl", spendSettlerImpl);
        vm.serializeAddress(obj, "safeFactory", safeFactory);
        vm.serializeAddress(obj, "defiInteractor", defiInteractor);
        vm.serializeAddress(obj, "treasuryVault", treasuryVault);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeUint(obj, "deployedAt", block.timestamp);

        string memory path = string.concat("deployments/", chainId, ".json");
        vm.writeJson(json, path);
        console2.log("\nDeployment JSON written to:", path);
    }
}
