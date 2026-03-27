# MultiSubs Smart Contracts

Solidity contracts powering the MultiSubs BaaS platform on Base. Built with Foundry, Safe v1.4.1, and Zodiac modules.

## Contracts

| Contract              | Lines | Description                                                                                                                                                                                                                    |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SpendSettler**      | ~240  | Zodiac module on M2 Safes. Settles card transactions by transferring USDC to the Platform Issuer Safe. Circular-buffer rolling spend tracking, idempotency on Lithic tx tokens, configurable max settle amount.                |
| **SafeFactory**       | ~370  | CREATE2 factory deploying fully configured M2 Safe bundles (Safe + SpendSettler + Roles + Delay) in one transaction. EIP-1167 minimal proxy clones. Uses ModuleSetupHelper for atomic module enablement via Safe delegatecall. |
| **TenantRegistry**    | ~195  | On-chain registry mapping tenantId to users to Safes. O(1) lookups, factory-only user registration, swap-and-pop removal, paginated views.                                                                                     |
| **DeFiInteractor**    | ~280  | M1 Treasury module for Morpho vault deposits/withdrawals/redemptions and Aave v3 supply/withdraw. Vault allowlist, balance-snapshot accounting, approval resets.                                                               |
| **TreasuryVault**     | ~330  | Per-tenant ERC-4626 share accounting wrapper over a Morpho vault position. Yield snapshots, loss-scenario redemption via `redeemForTenant`, vault migration protection.                                                        |
| **ModuleSetupHelper** | ~45   | Stateless helper that a Safe delegatecalls during `setup()` to enable modules and initialize Zodiac clones atomically.                                                                                                         |

## Architecture

```
SafeFactory ──deploy──> M2 Safe (EIP-1167 clone)
    |                      |
    +── SpendSettler       +── enabled as module
    +── Roles Module       +── enabled as module (via ModuleSetupHelper delegatecall)
    +── Delay Module       +── enabled as module
    |
    +── registers in ──> TenantRegistry

M1 Treasury Safe
    |
    +── DeFiInteractor ──> Morpho Vault (deposit/withdraw/redeem)
    |                  ──> Aave v3 Pool (supply/withdraw)
    +── TreasuryVault ──> Per-tenant share accounting over Morpho
```

## Setup

```bash
# Install dependencies (forge-std, OpenZeppelin, Safe)
forge install

# Build
forge build

# Run tests (283 tests)
forge test -vv

# Run tests with gas report
forge test --gas-report

# Format
forge fmt
```

## Testing

283 tests across 5 test suites:

| Suite          | Tests | Coverage                                                                                                 |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| SpendSettler   | 41    | Constructor, settle, idempotency, rolling spend, pause, ownership, max amount, fuzz                      |
| SafeFactory    | 74    | Model A/B deploy, CREATE2 determinism, module enablement, Roles/Delay, config setters, fuzz              |
| TenantRegistry | 45    | Tenant/user registration, factory auth, pagination, swap-and-pop, fuzz                                   |
| DeFiInteractor | 54    | Morpho deposit/withdraw/redeem, Aave supply/withdraw, allowlist, approval reset, fuzz                    |
| TreasuryVault  | 69    | Per-tenant deposit/withdraw/redeem, yield snapshots, batch limits, vault migration, loss scenarios, fuzz |

```bash
# Run all tests
forge test

# Run a specific suite
forge test --match-contract SpendSettlerTest

# Run a specific test
forge test --match-test test_settle_transfersUSDC -vvvv

# Fuzz tests (256 runs by default)
forge test --match-test testFuzz
```

## Deployment

### Testnet (Base Sepolia)

Deploys mock tokens, test Safes, full infrastructure, and runs a test settlement:

```bash
# Configure .env
cp ../../.env.example .env
# Set DEPLOYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL

# Deploy everything
forge script script/DeployTestnet.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast

# Deployed addresses written to deployments/84532.json
```

### Mainnet (Base)

Requires pre-deployed M1 Treasury Safe and all addresses configured in `.env`:

```bash
forge script script/DeployAll.s.sol \
  --rpc-url $BASE_MAINNET_RPC_URL \
  --broadcast \
  --verify

# Deployed addresses written to deployments/8453.json
```

### Verification

```bash
# Print forge verify-contract commands for all deployed contracts
forge script script/VerifyContracts.s.sol
```

## Security

Three security review passes completed. Key hardening:

- **Two-step ownership** on all Module-based contracts (pendingOwner + acceptOwnership) and Ownable2Step on SafeFactory/TenantRegistry
- **Balance snapshot pattern** (before/after) for all DeFi share accounting -- eliminates exchange rate manipulation
- **Approval reset to 0** after every deposit/supply operation
- **Circular buffer** for spend history (fixed 200 slots, no unbounded storage growth)
- **MaxSettleAmount cap** on settlements + idempotency via Lithic tx tokens
- **ModuleSetupHelper** enables modules atomically via Safe delegatecall during setup
- **Vault migration protection** blocks `setMorphoVault` when tenant positions exist
- **Pre-check + post-check** on withdrawals for early revert + safety net
- **Batch size limit** (100) on yield snapshots to prevent gas exhaustion DoS

## Key Addresses (Base Mainnet)

| Contract                   | Address                                      |
| -------------------------- | -------------------------------------------- |
| USDC                       | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Safe Singleton v1.4.1      | (see Base Safe deployment registry)          |
| Morpho Gauntlet USDC Prime | (see Morpho deployment docs)                 |

Deployed MultiSubs contract addresses are written to `deployments/{chainId}.json` after deployment.
