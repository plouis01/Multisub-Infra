// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpendSettler} from "../../src/SpendSettler.sol";
import {ISpendSettler} from "../../src/interfaces/ISpendSettler.sol";
import {MockSafe} from "../mocks/MockSafe.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {SpendSettlerHandler} from "./SpendSettlerHandler.sol";

/// @notice Invariant tests for SpendSettler.
///         Verifies settlement accounting and idempotency invariants hold
///         after arbitrary sequences of settlements.
contract SpendSettlerInvariantTest is Test {
    SpendSettlerHandler public handler;
    SpendSettler public settler;
    MockSafe public safe;
    MockERC20 public usdc;

    address public owner = address(0xAA);
    address public settlerEOA = address(0xBB);
    address public issuerSafe = address(0xCC);

    function setUp() public {
        // Deploy mocks
        safe = new MockSafe();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy SpendSettler
        vm.prank(owner);
        settler = new SpendSettler(address(safe), owner, settlerEOA, issuerSafe, address(usdc));

        // Enable module on Safe
        safe.enableModule(address(settler));

        // Deploy handler
        handler = new SpendSettlerHandler(settler, safe, usdc, issuerSafe);

        // Target only the handler for fuzzing
        targetContract(address(handler));
    }

    // ============ Invariant 1: totalSettled == ghost_totalSettled ============

    function invariant_totalSettledMatchesGhost() public view {
        assertEq(settler.totalSettled(), handler.ghost_totalSettled(), "totalSettled diverged from ghost tracking");
    }

    // ============ Invariant 2: nonce == number of successful settlements ============

    function invariant_nonceMatchesSettlementCount() public view {
        assertEq(settler.nonce(), handler.ghost_nonce(), "nonce diverged from settlement count");
    }

    // ============ Invariant 3: Once settledTxTokens[token] is true, it stays true ============

    function invariant_settledTokensPersist() public view {
        uint256 count = handler.settledTokenCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 token = handler.settledTokens(i);
            assertTrue(settler.settledTxTokens(token), "Previously settled token lost its settled status");
        }
    }

    // ============ Invariant 4: getRollingSpend() <= totalSettled ============

    function invariant_rollingSpendBoundedByTotal() public view {
        assertLe(settler.getRollingSpend(), settler.totalSettled(), "Rolling spend exceeds total settled");
    }

    // ============ Invariant 5: Replay never increments nonce ============

    function invariant_replayNeverSucceeds() public view {
        // settleReplay call counter should always be 0 -- replays should always revert
        assertEq(handler.calls_settleReplay(), 0, "A replay settlement succeeded (idempotency violation)");
    }

    /// @notice Log call statistics after all invariant runs
    function invariant_callSummary() public view {
        assert(true);
    }
}
