// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

/// @notice Mock Morpho Vault that simulates ERC4626 behavior for testing.
///         Tracks shares/assets with a configurable exchange rate to simulate yield.
contract MockMorphoVault {
    MockERC20 public underlyingAsset;

    string public name = "Mock Morpho Vault";
    string public symbol = "mMV";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    uint256 public totalAssets;

    /// @notice Exchange rate numerator (assets per share, scaled by 1e6)
    /// @dev Default 1:1 ratio. Set > 1e6 to simulate yield accrual.
    uint256 public exchangeRate = 1e6;
    uint256 public constant RATE_SCALE = 1e6;

    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );

    constructor(address _asset) {
        underlyingAsset = MockERC20(_asset);
    }

    function asset() external view returns (address) {
        return address(underlyingAsset);
    }

    // ============ ERC4626 Core ============

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        underlyingAsset.transferFrom(msg.sender, address(this), assets);
        balanceOf[receiver] += shares;
        totalSupply += shares;
        totalAssets += assets;
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(balanceOf[owner_] >= shares, "MockMorphoVault: insufficient shares");
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
        totalAssets -= assets;
        underlyingAsset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        require(balanceOf[owner_] >= shares, "MockMorphoVault: insufficient shares");
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
        totalAssets -= assets;
        underlyingAsset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    // ============ View Functions ============

    function convertToShares(uint256 assets) public view returns (uint256) {
        // shares = assets * RATE_SCALE / exchangeRate
        return (assets * RATE_SCALE) / exchangeRate;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        // assets = shares * exchangeRate / RATE_SCALE
        return (shares * exchangeRate) / RATE_SCALE;
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    // ============ Test Helpers ============

    /// @notice Set the exchange rate to simulate yield accrual
    /// @param newRate New rate (1e6 = 1:1, 1.05e6 = 5% yield)
    function setExchangeRate(uint256 newRate) external {
        exchangeRate = newRate;
    }

    /// @notice Simulate yield by increasing total assets without minting shares
    function simulateYield(uint256 additionalAssets) external {
        totalAssets += additionalAssets;
        // Recalculate exchange rate based on total assets / total supply
        if (totalSupply > 0) {
            exchangeRate = (totalAssets * RATE_SCALE) / totalSupply;
        }
    }
}
