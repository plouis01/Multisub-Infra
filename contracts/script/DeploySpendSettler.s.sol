// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {SpendSettler} from "../src/SpendSettler.sol";

/// @notice Deploy SpendSettler module for an M2 Safe on Base Sepolia / Mainnet
contract DeploySpendSettler is Script {
    function run() external {
        address m2Safe = vm.envAddress("M2_SAFE_ADDRESS");
        address ownerAddr = vm.envAddress("OWNER_ADDRESS");
        address settlerAddr = vm.envAddress("SETTLER_ADDRESS");
        address issuerSafe = vm.envAddress("PLATFORM_ISSUER_SAFE_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        console2.log("Deploying SpendSettler...");
        console2.log("  M2 Safe:", m2Safe);
        console2.log("  Owner:", ownerAddr);
        console2.log("  Settler:", settlerAddr);
        console2.log("  Issuer Safe:", issuerSafe);
        console2.log("  USDC:", usdc);

        vm.startBroadcast(deployerKey);

        SpendSettler settler = new SpendSettler(m2Safe, ownerAddr, settlerAddr, issuerSafe, usdc);

        vm.stopBroadcast();

        console2.log("SpendSettler deployed at:", address(settler));
        console2.log("");
        console2.log("Post-deployment steps:");
        console2.log("  1. Safe.enableModule(", address(settler), ")");
        console2.log("  2. Verify on Basescan");
    }
}
