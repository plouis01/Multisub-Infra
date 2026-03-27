// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

/// @title VerifyContracts
/// @notice Reads deployed addresses from `deployments/{chainId}.json` and prints
///         the forge verify-contract commands for each contract. Run this after
///         deployment to verify all contracts on Basescan.
///
/// @dev Usage:
///   forge script script/VerifyContracts.s.sol --rpc-url base_sepolia
///   forge script script/VerifyContracts.s.sol --rpc-url base_mainnet
///
///   Then copy/paste each verification command or pipe to bash.
///   Alternatively, run with --broadcast on the original deploy to auto-verify
///   using forge's built-in verification flow.
contract VerifyContracts is Script {
    function run() external view {
        string memory chainId = vm.toString(block.chainid);
        string memory path = string.concat("deployments/", chainId, ".json");
        string memory json = vm.readFile(path);

        console2.log("\n========================================");
        console2.log("  Contract Verification Commands");
        console2.log("  Chain ID:", block.chainid);
        console2.log("========================================\n");

        // Read addresses from deployment JSON
        address moduleSetupHelper = vm.parseJsonAddress(json, ".moduleSetupHelper");
        address tenantRegistry = vm.parseJsonAddress(json, ".tenantRegistry");
        address spendSettlerImpl = vm.parseJsonAddress(json, ".spendSettlerImpl");
        address safeFactoryAddr = vm.parseJsonAddress(json, ".safeFactory");
        address defiInteractorAddr = vm.parseJsonAddress(json, ".defiInteractor");
        address treasuryVaultAddr = vm.parseJsonAddress(json, ".treasuryVault");
        address deployerAddr = vm.parseJsonAddress(json, ".deployer");

        // Read env vars needed for constructor args
        address m1Safe = vm.envAddress("M1_SAFE_ADDRESS");
        address settlerAddr = vm.envAddress("SETTLER_ADDRESS");
        address yieldOperator = vm.envAddress("YIELD_OPERATOR_ADDRESS");
        address issuerSafe = vm.envAddress("PLATFORM_ISSUER_SAFE_ADDRESS");
        address usdcAddr = vm.envAddress("USDC_ADDRESS");
        address morphoVaultAddr = vm.envAddress("MORPHO_VAULT_ADDRESS");
        address safeSingleton = vm.envAddress("SAFE_SINGLETON_ADDRESS");
        address rolesModuleImpl = vm.envAddress("ROLES_MODULE_ADDRESS");
        address delayModuleImpl = vm.envAddress("DELAY_MODULE_ADDRESS");

        // Determine RPC alias
        string memory rpcAlias = block.chainid == 84532 ? "base_sepolia" : "base_mainnet";

        // 1. ModuleSetupHelper — no constructor args
        console2.log("# 1. ModuleSetupHelper");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(moduleSetupHelper),
                " src/ModuleSetupHelper.sol:ModuleSetupHelper",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        // 2. TenantRegistry — constructor(address _initialOwner)
        console2.log("# 2. TenantRegistry");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(tenantRegistry),
                " src/TenantRegistry.sol:TenantRegistry",
                " --constructor-args $(cast abi-encode 'constructor(address)' ",
                vm.toString(deployerAddr),
                ")",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        // 3. SpendSettler impl — constructor(address,address,address,address,address)
        console2.log("# 3. SpendSettler implementation");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(spendSettlerImpl),
                " src/SpendSettler.sol:SpendSettler",
                " --constructor-args $(cast abi-encode 'constructor(address,address,address,address,address)' ",
                vm.toString(address(1)),
                " ",
                vm.toString(deployerAddr),
                " ",
                vm.toString(settlerAddr),
                " ",
                vm.toString(issuerSafe),
                " ",
                vm.toString(usdcAddr),
                ")",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        // 4. SafeFactory — constructor(address,address,address,address,address,address,address,address)
        console2.log("# 4. SafeFactory");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(safeFactoryAddr),
                " src/SafeFactory.sol:SafeFactory",
                " --constructor-args $(cast abi-encode ",
                "'constructor(address,address,address,address,address,address,address,address)' ",
                vm.toString(deployerAddr),
                " ",
                vm.toString(safeSingleton),
                " ",
                vm.toString(spendSettlerImpl),
                " ",
                vm.toString(settlerAddr),
                " ",
                vm.toString(issuerSafe),
                " ",
                vm.toString(usdcAddr),
                " ",
                vm.toString(rolesModuleImpl),
                " ",
                vm.toString(delayModuleImpl),
                ")",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        // 5. DeFiInteractor — constructor(address,address,address)
        console2.log("# 5. DeFiInteractor");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(defiInteractorAddr),
                " src/DeFiInteractor.sol:DeFiInteractor",
                " --constructor-args $(cast abi-encode 'constructor(address,address,address)' ",
                vm.toString(m1Safe),
                " ",
                vm.toString(deployerAddr),
                " ",
                vm.toString(yieldOperator),
                ")",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        // 6. TreasuryVault — constructor(address,address,address,address,address)
        console2.log("# 6. TreasuryVault");
        console2.log(
            string.concat(
                "forge verify-contract ",
                vm.toString(treasuryVaultAddr),
                " src/TreasuryVault.sol:TreasuryVault",
                " --constructor-args $(cast abi-encode 'constructor(address,address,address,address,address)' ",
                vm.toString(m1Safe),
                " ",
                vm.toString(deployerAddr),
                " ",
                vm.toString(yieldOperator),
                " ",
                vm.toString(morphoVaultAddr),
                " ",
                vm.toString(usdcAddr),
                ")",
                " --chain ",
                chainId,
                " --etherscan-api-key $BASESCAN_API_KEY",
                " --verifier-url ",
                _basescanApiUrl(),
                " --watch"
            )
        );
        console2.log("");

        console2.log("========================================");
        console2.log("  Alternatively, redeploy with --verify:");
        console2.log(
            string.concat("  forge script script/DeployAll.s.sol --rpc-url ", rpcAlias, " --broadcast --verify")
        );
        console2.log("========================================\n");
    }

    function _basescanApiUrl() internal view returns (string memory) {
        if (block.chainid == 84532) {
            return "https://api-sepolia.basescan.org/api";
        }
        return "https://api.basescan.org/api";
    }
}
