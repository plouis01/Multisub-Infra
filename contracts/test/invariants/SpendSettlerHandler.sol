// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpendSettler} from "../../src/SpendSettler.sol";
import {MockSafe} from "../mocks/MockSafe.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Handler contract for SpendSettler invariant (stateful fuzz) tests.
///         Exposes bounded settle actions that the fuzzer calls in random sequences.
contract SpendSettlerHandler is Test {
    SpendSettler public settler;
    MockSafe public safe;
    MockERC20 public usdc;
    address public issuerSafe;

    // Ghost variables for independent tracking
    uint256 public ghost_totalSettled;
    uint256 public ghost_nonce;

    // Track all tx tokens we have settled (for idempotency invariant)
    bytes32[] public settledTokens;
    mapping(bytes32 => bool) public ghost_settledMap;

    // Call counters
    uint256 public calls_settle;
    uint256 public calls_settleReplay;

    // Incrementing counter to generate unique tx tokens
    uint256 private _txCounter;

    constructor(SpendSettler _settler, MockSafe _safe, MockERC20 _usdc, address _issuerSafe) {
        settler = _settler;
        safe = _safe;
        usdc = _usdc;
        issuerSafe = _issuerSafe;
    }

    /// @notice Settle a new unique transaction
    function settle(uint256 amount) external {
        amount = bound(amount, 1e6, 100_000e6); // 1 USDC to 100K USDC

        // Generate a unique tx token
        _txCounter++;
        bytes32 txToken = keccak256(abi.encodePacked(_txCounter));

        // Fund the Safe so it has enough USDC
        usdc.mint(address(safe), amount);

        vm.prank(settler.settler());
        try settler.settle(amount, txToken) {
            ghost_totalSettled += amount;
            ghost_nonce++;
            settledTokens.push(txToken);
            ghost_settledMap[txToken] = true;
            calls_settle++;
        } catch {
            // Revert is acceptable (e.g., paused, max settle)
        }
    }

    /// @notice Try to replay a previously settled transaction (should always revert)
    function settleReplay(uint256 tokenSeed) external {
        if (settledTokens.length == 0) return;

        bytes32 txToken = settledTokens[tokenSeed % settledTokens.length];
        uint256 amount = 1e6;
        usdc.mint(address(safe), amount);

        vm.prank(settler.settler());
        try settler.settle(amount, txToken) {
            // This should never succeed -- if it does, the invariant test will catch it
            calls_settleReplay++;
        } catch {
            // Expected: AlreadySettled revert
        }
    }

    /// @notice Get count of settled tokens
    function settledTokenCount() external view returns (uint256) {
        return settledTokens.length;
    }
}
