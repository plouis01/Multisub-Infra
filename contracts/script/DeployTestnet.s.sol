// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ModuleSetupHelper} from "../src/ModuleSetupHelper.sol";
import {TenantRegistry} from "../src/TenantRegistry.sol";
import {SafeFactory} from "../src/SafeFactory.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {SpendSettler} from "../src/SpendSettler.sol";
import {ISafe} from "../src/interfaces/ISafe.sol";

/// @title MockERC20
/// @notice Minimal mock ERC20 for testnet deployments
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

/// @title DeployTestnet
/// @notice Simplified testnet deployment that deploys mock tokens, a test M1 Safe,
///         the full MultiSubs infrastructure, a test M2 Safe, funds it, and runs
///         a test settlement to verify the flow works end-to-end.
///
/// @dev This script is self-contained for Base Sepolia testing. It deploys:
///   1. MockERC20 as USDC (mints 10M to deployer)
///   2. Test M1 Safe (EIP-1167 clone of Safe singleton)
///   3. Full infrastructure (ModuleSetupHelper, TenantRegistry, SafeFactory, etc.)
///   4. Test M2 Safe via SafeFactory
///   5. Funds the M2 Safe with 10K USDC
///   6. Runs a test settlement to verify the flow
contract DeployTestnet is Script {
    // ── Constants ─────────────────────────────────────────────────────────

    uint256 constant MOCK_USDC_SUPPLY = 10_000_000e6; // 10M USDC (6 decimals)
    uint256 constant M2_FUND_AMOUNT = 10_000e6; // 10K USDC
    uint256 constant TEST_SETTLE_AMOUNT = 100e6; // 100 USDC
    bytes32 constant TEST_TENANT_ID = keccak256("testnet-tenant-1");
    bytes32 constant TEST_TX_TOKEN = keccak256("testnet-lithic-tx-001");

    // ── Deployed addresses ────────────────────────────────────────────────
    address public mockUsdc;
    address public mockMorphoVault;
    address public m1Safe;
    address public moduleSetupHelper;
    address public tenantRegistry;
    address public spendSettlerImpl;
    address public safeFactory;
    address public defiInteractor;
    address public treasuryVault;
    address public m2Safe;
    address public m2SpendSettler;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        // The settler service EOA — on testnet, same as deployer for simplicity
        address settlerAddr = vm.envOr("SETTLER_ADDRESS", deployer);
        address yieldOperator = vm.envOr("YIELD_OPERATOR_ADDRESS", deployer);
        address issuerSafe = vm.envOr("PLATFORM_ISSUER_SAFE_ADDRESS", deployer);
        address safeSingleton = vm.envAddress("SAFE_SINGLETON_ADDRESS");

        // Optional Zodiac singletons (address(0) to skip)
        address rolesModuleImpl = vm.envOr("ROLES_MODULE_ADDRESS", address(0));
        address delayModuleImpl = vm.envOr("DELAY_MODULE_ADDRESS", address(0));

        console2.log("\n========================================");
        console2.log("  MultiSubs Testnet Deployment");
        console2.log("========================================");
        console2.log("  Deployer:       ", deployer);
        console2.log("  Settler:        ", settlerAddr);
        console2.log("  Yield Operator: ", yieldOperator);
        console2.log("  Safe Singleton: ", safeSingleton);
        console2.log("========================================\n");

        vm.startBroadcast(deployerKey);

        // ══════════════════════════════════════════════════════════════════
        // STEP 1: Deploy Mock Tokens
        // ══════════════════════════════════════════════════════════════════

        console2.log("--- Step 1: Deploy Mock Tokens ---");

        MockERC20 usdc = new MockERC20("USD Coin (Mock)", "USDC", 6);
        mockUsdc = address(usdc);
        usdc.mint(deployer, MOCK_USDC_SUPPLY);
        console2.log("MockUSDC deployed:", mockUsdc);
        console2.log("  Minted", MOCK_USDC_SUPPLY / 1e6, "USDC to deployer");

        // Deploy a mock Morpho vault (just another mock token acting as vault)
        // In a real testnet scenario, you would use an actual Morpho vault address
        MockERC20 morpho = new MockERC20("Mock Morpho Vault", "mUSDC", 6);
        mockMorphoVault = address(morpho);
        console2.log("MockMorphoVault deployed:", mockMorphoVault);

        // ══════════════════════════════════════════════════════════════════
        // STEP 2: Deploy Test M1 Safe
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Step 2: Deploy Test M1 Safe ---");

        m1Safe = Clones.clone(safeSingleton);
        console2.log("M1 Safe proxy deployed:", m1Safe);

        // Setup M1 Safe: deployer as sole owner, threshold 1
        address[] memory m1Owners = new address[](1);
        m1Owners[0] = deployer;
        ISafe(m1Safe).setup(m1Owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)));
        console2.log("  M1 Safe initialized with deployer as owner");

        // ══════════════════════════════════════════════════════════════════
        // STEP 3: Deploy Full Infrastructure
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Step 3: Deploy Infrastructure ---");

        // 3a. ModuleSetupHelper
        ModuleSetupHelper helper = new ModuleSetupHelper();
        moduleSetupHelper = address(helper);
        console2.log("ModuleSetupHelper:", moduleSetupHelper);

        // 3b. TenantRegistry
        TenantRegistry registry = new TenantRegistry(deployer);
        tenantRegistry = address(registry);
        console2.log("TenantRegistry:", tenantRegistry);

        // 3c. SpendSettler implementation
        SpendSettler settlerImplContract = new SpendSettler(address(1), deployer, settlerAddr, issuerSafe, mockUsdc);
        spendSettlerImpl = address(settlerImplContract);
        console2.log("SpendSettler impl:", spendSettlerImpl);

        // 3d. SafeFactory
        SafeFactory factory = new SafeFactory(
            deployer,
            safeSingleton,
            spendSettlerImpl,
            settlerAddr,
            issuerSafe,
            mockUsdc,
            rolesModuleImpl,
            delayModuleImpl
        );
        safeFactory = address(factory);
        console2.log("SafeFactory:", safeFactory);

        // Wire up factory <-> registry <-> helper
        factory.setRegistry(tenantRegistry);
        factory.setModuleSetupHelper(moduleSetupHelper);
        registry.setFactory(safeFactory);
        console2.log("  Factory <-> Registry wired");

        // 3e. DeFiInteractor
        DeFiInteractor defi = new DeFiInteractor(m1Safe, deployer, yieldOperator);
        defiInteractor = address(defi);
        console2.log("DeFiInteractor:", defiInteractor);

        // 3f. TreasuryVault
        TreasuryVault vault = new TreasuryVault(m1Safe, deployer, yieldOperator, mockMorphoVault, mockUsdc);
        treasuryVault = address(vault);
        console2.log("TreasuryVault:", treasuryVault);

        // 3g. Allowlist Morpho vault on DeFiInteractor
        defi.addAllowlistedVault(mockMorphoVault);
        console2.log("  Morpho vault allowlisted on DeFiInteractor");

        // 3h. Enable modules on M1 Safe
        ISafe(m1Safe).enableModule(defiInteractor);
        ISafe(m1Safe).enableModule(treasuryVault);
        console2.log("  DeFiInteractor enabled on M1 Safe");
        console2.log("  TreasuryVault enabled on M1 Safe");

        // ══════════════════════════════════════════════════════════════════
        // STEP 4: Deploy Test M2 Safe via SafeFactory
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Step 4: Deploy Test M2 Safe ---");

        // Register the test tenant first
        registry.registerTenant(TEST_TENANT_ID, issuerSafe);
        console2.log("Test tenant registered:", vm.toString(TEST_TENANT_ID));

        // Deploy M2 Safe — Model A (platform-custodial with modules)
        m2Safe = factory.deploySafe(TEST_TENANT_ID, deployer, 0);
        m2SpendSettler = factory.getSettlerForSafe(m2Safe);
        console2.log("M2 Safe deployed:", m2Safe);
        console2.log("  SpendSettler:", m2SpendSettler);

        // ══════════════════════════════════════════════════════════════════
        // STEP 5: Fund M2 Safe with 10K USDC
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Step 5: Fund M2 Safe ---");

        usdc.transfer(m2Safe, M2_FUND_AMOUNT);
        uint256 m2Balance = usdc.balanceOf(m2Safe);
        console2.log("M2 Safe USDC balance:", m2Balance / 1e6, "USDC");

        // ══════════════════════════════════════════════════════════════════
        // STEP 6: Test Settlement
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n--- Step 6: Test Settlement ---");

        uint256 issuerBalanceBefore = usdc.balanceOf(issuerSafe);
        console2.log("Issuer balance before:", issuerBalanceBefore / 1e6, "USDC");

        // Settle 100 USDC
        SpendSettler(m2SpendSettler).settle(TEST_SETTLE_AMOUNT, TEST_TX_TOKEN);

        uint256 issuerBalanceAfter = usdc.balanceOf(issuerSafe);
        uint256 m2BalanceAfter = usdc.balanceOf(m2Safe);
        console2.log("Settlement of", TEST_SETTLE_AMOUNT / 1e6, "USDC successful!");
        console2.log("  Issuer balance after:", issuerBalanceAfter / 1e6, "USDC");
        console2.log("  M2 Safe balance after:", m2BalanceAfter / 1e6, "USDC");

        // Verify idempotency
        bool isSettled = SpendSettler(m2SpendSettler).isSettled(TEST_TX_TOKEN);
        console2.log("  Idempotency check (isSettled):", isSettled);

        vm.stopBroadcast();

        // ══════════════════════════════════════════════════════════════════
        // Write deployment JSON
        // ══════════════════════════════════════════════════════════════════

        _writeDeploymentJson(deployer);

        // ══════════════════════════════════════════════════════════════════
        // Summary
        // ══════════════════════════════════════════════════════════════════

        console2.log("\n========================================");
        console2.log("  TESTNET DEPLOYMENT COMPLETE");
        console2.log("========================================");
        console2.log("  Chain ID:          ", block.chainid);
        console2.log("  Deployer:          ", deployer);
        console2.log("  MockUSDC:          ", mockUsdc);
        console2.log("  MockMorphoVault:   ", mockMorphoVault);
        console2.log("  M1 Safe:           ", m1Safe);
        console2.log("  ModuleSetupHelper: ", moduleSetupHelper);
        console2.log("  TenantRegistry:    ", tenantRegistry);
        console2.log("  SpendSettler impl: ", spendSettlerImpl);
        console2.log("  SafeFactory:       ", safeFactory);
        console2.log("  DeFiInteractor:    ", defiInteractor);
        console2.log("  TreasuryVault:     ", treasuryVault);
        console2.log("  M2 Safe:           ", m2Safe);
        console2.log("  M2 SpendSettler:   ", m2SpendSettler);
        console2.log("========================================\n");
    }

    function _writeDeploymentJson(address deployer_) internal {
        string memory chainId = vm.toString(block.chainid);
        string memory obj = "testnet_deployment";

        vm.serializeAddress(obj, "mockUsdc", mockUsdc);
        vm.serializeAddress(obj, "mockMorphoVault", mockMorphoVault);
        vm.serializeAddress(obj, "m1Safe", m1Safe);
        vm.serializeAddress(obj, "moduleSetupHelper", moduleSetupHelper);
        vm.serializeAddress(obj, "tenantRegistry", tenantRegistry);
        vm.serializeAddress(obj, "spendSettlerImpl", spendSettlerImpl);
        vm.serializeAddress(obj, "safeFactory", safeFactory);
        vm.serializeAddress(obj, "defiInteractor", defiInteractor);
        vm.serializeAddress(obj, "treasuryVault", treasuryVault);
        vm.serializeAddress(obj, "m2Safe", m2Safe);
        vm.serializeAddress(obj, "m2SpendSettler", m2SpendSettler);
        vm.serializeAddress(obj, "deployer", deployer_);
        vm.serializeBool(obj, "isTestnet", true);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeUint(obj, "deployedAt", block.timestamp);

        string memory path = string.concat("deployments/", chainId, ".json");
        vm.writeJson(json, path);
        console2.log("\nDeployment JSON written to:", path);
    }
}
