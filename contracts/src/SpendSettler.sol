// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Module} from "./base/Module.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {ISpendSettler} from "./interfaces/ISpendSettler.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SpendSettler
/// @notice Zodiac module for M2 Safes that settles card transactions by transferring
///         USDC to the Platform Issuer Safe. Called by the settlement service backend.
/// @dev Replaces SpendInteractor from Bank repo. Stripped Unlink routing, recipientHash,
///      and transferType. Primary limit enforcement is via Zodiac Roles v2 allowances;
///      this contract provides rolling spend tracking for observability and an additional
///      validation layer with idempotency on Lithic transaction tokens.
contract SpendSettler is Module, ReentrancyGuard, Pausable, ISpendSettler {
    // ============ Constants ============

    /// @notice 24-hour rolling window for spend tracking
    uint256 public constant WINDOW_DURATION = 24 hours;

    /// @notice Max spend records per window (gas safety)
    uint256 public constant MAX_RECORDS = 200;

    // ============ Immutables ============

    // ============ State ============

    /// @notice Authorized settlement service address
    address public settler;

    /// @notice Platform Issuer Safe that receives settlement funds
    address public issuerSafe;

    /// @notice USDC token address on Base
    address public usdc;

    /// @notice Global nonce counter
    uint256 public nonce;

    /// @notice Total USDC settled through this module
    uint256 public totalSettled;

    /// @notice Maximum amount allowed per single settlement
    uint256 public maxSettleAmount;

    /// @notice Idempotency: tracks settled Lithic transaction tokens
    mapping(bytes32 => bool) public settledTxTokens;

    // ============ Rolling Spend Tracking ============

    struct SpendRecord {
        uint128 amount;
        uint128 timestamp;
    }

    SpendRecord[200] private _spendRecords; // Fixed-size circular buffer (MAX_RECORDS)
    uint256 private _recordHead; // Next write position
    uint256 private _recordCount; // Number of active records

    // ============ Errors ============

    error OnlySettler();
    error ZeroAmount();
    error AlreadySettled(bytes32 lithicTxToken);
    error TransferFailed();
    error InvalidSettler();
    error InvalidIssuerSafe();
    error InvalidUsdcAddress();
    error AmountTooLarge();
    error AmountExceedsMaxSettle(uint256 amount, uint256 max);

    // ============ Events ============

    event EmergencyPaused(address indexed by);
    event EmergencyUnpaused(address indexed by);

    // ============ Modifiers ============

    modifier onlySettler() {
        if (msg.sender != settler) revert OnlySettler();
        _;
    }

    // ============ Constructor ============

    /// @param _avatar The M2 Safe address this module is attached to
    /// @param _owner Owner (typically the M2 Safe or admin multisig)
    /// @param _settler Address of the settlement service backend
    /// @param _issuerSafe Platform Issuer Safe receiving settlements
    /// @param _usdc USDC token contract address
    constructor(address _avatar, address _owner, address _settler, address _issuerSafe, address _usdc)
        Module(_avatar, _avatar, _owner)
    {
        if (_settler == address(0)) revert InvalidSettler();
        if (_issuerSafe == address(0)) revert InvalidIssuerSafe();
        if (_usdc == address(0)) revert InvalidUsdcAddress();

        settler = _settler;
        issuerSafe = _issuerSafe;
        usdc = _usdc;
        maxSettleAmount = type(uint256).max;

        emit SettlerUpdated(address(0), _settler);
        emit IssuerSafeUpdated(address(0), _issuerSafe);
        emit UsdcAddressUpdated(address(0), _usdc);
    }

    // ============ Emergency Controls ============

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender);
    }

    // ============ Core Settlement ============

    /// @inheritdoc ISpendSettler
    function settle(uint256 amount, bytes32 lithicTxToken) external override onlySettler nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (amount > maxSettleAmount) revert AmountExceedsMaxSettle(amount, maxSettleAmount);
        if (settledTxTokens[lithicTxToken]) revert AlreadySettled(lithicTxToken);

        // Mark as settled (idempotency)
        settledTxTokens[lithicTxToken] = true;

        // Record spend for rolling window tracking
        _recordSpend(amount);

        // Execute USDC transfer through the M2 Safe
        bytes memory transferData = abi.encodeWithSelector(IERC20.transfer.selector, issuerSafe, amount);
        bool success = exec(usdc, 0, transferData, ISafe.Operation.Call);
        if (!success) revert TransferFailed();

        // Update totals
        uint256 currentNonce;
        unchecked {
            currentNonce = nonce++;
        }
        totalSettled += amount;

        emit SpendSettled(avatar, issuerSafe, amount, lithicTxToken, currentNonce);
    }

    // ============ Admin Functions ============

    function setSettler(address _settler) external onlyOwner {
        if (_settler == address(0)) revert InvalidSettler();
        address prev = settler;
        settler = _settler;
        emit SettlerUpdated(prev, _settler);
    }

    function setIssuerSafe(address _issuerSafe) external onlyOwner {
        if (_issuerSafe == address(0)) revert InvalidIssuerSafe();
        address prev = issuerSafe;
        issuerSafe = _issuerSafe;
        emit IssuerSafeUpdated(prev, _issuerSafe);
    }

    function setUsdc(address _usdc) external onlyOwner {
        if (_usdc == address(0)) revert InvalidUsdcAddress();
        address prev = usdc;
        usdc = _usdc;
        emit UsdcAddressUpdated(prev, _usdc);
    }

    function setMaxSettleAmount(uint256 _max) external onlyOwner {
        maxSettleAmount = _max;
        emit MaxSettleAmountUpdated(_max);
    }

    // ============ View Functions ============

    /// @inheritdoc ISpendSettler
    function getRollingSpend() external view override returns (uint256) {
        return _getRollingSpend();
    }

    /// @inheritdoc ISpendSettler
    function getTotalSettled() external view override returns (uint256) {
        return totalSettled;
    }

    /// @inheritdoc ISpendSettler
    function isSettled(bytes32 lithicTxToken) external view override returns (bool) {
        return settledTxTokens[lithicTxToken];
    }

    /// @notice Number of active spend records in the current window
    function getActiveRecordCount() external view returns (uint256) {
        return _recordCount;
    }

    // ============ Internal Functions ============

    /// @notice Calculate total spend within the rolling 24h window
    function _getRollingSpend() internal view returns (uint256 total) {
        uint256 count = _recordCount;
        if (count == 0) return 0;

        uint256 windowStart = block.timestamp > WINDOW_DURATION ? block.timestamp - WINDOW_DURATION : 0;

        // Read backwards from most recent entry
        uint256 idx = _recordHead;
        for (uint256 i = 0; i < count; i++) {
            // Go back one position (circular)
            idx = idx == 0 ? MAX_RECORDS - 1 : idx - 1;
            SpendRecord storage record = _spendRecords[idx];
            if (uint256(record.timestamp) < windowStart) break;
            total += uint256(record.amount);
        }
    }

    /// @notice Record a spend to the circular buffer
    function _recordSpend(uint256 amount) internal {
        if (amount > type(uint128).max) revert AmountTooLarge();

        // Write to circular buffer at head position
        _spendRecords[_recordHead] = SpendRecord({amount: uint128(amount), timestamp: uint128(block.timestamp)});

        // Advance head (wrap around)
        unchecked {
            _recordHead = (_recordHead + 1) % MAX_RECORDS;
            if (_recordCount < MAX_RECORDS) {
                _recordCount++;
            }
        }
    }
}
