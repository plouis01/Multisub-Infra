// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

/// @notice Mock Aave V3 Pool that simulates supply/withdraw for testing.
///         Tracks deposited balances per user and mints/burns a mock aToken.
contract MockAavePool {
    /// @notice Track deposits per user per asset
    mapping(address => mapping(address => uint256)) public deposits;

    /// @notice Mock aToken (optional, for balance tracking)
    mapping(address => MockERC20) public aTokens;

    event Supply(address indexed asset, address indexed onBehalfOf, uint256 amount, uint16 referralCode);
    event Withdraw(address indexed asset, address indexed to, uint256 amount);

    /// @notice Register an aToken for an asset (for testing)
    function setAToken(address asset, address aToken) external {
        aTokens[asset] = MockERC20(aToken);
    }

    /// @notice Simulate Aave V3 supply
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external {
        MockERC20(asset).transferFrom(msg.sender, address(this), amount);
        deposits[onBehalfOf][asset] += amount;

        // Mint aTokens if configured
        if (address(aTokens[asset]) != address(0)) {
            aTokens[asset].mint(onBehalfOf, amount);
        }

        emit Supply(asset, onBehalfOf, amount, referralCode);
    }

    /// @notice Simulate Aave V3 withdraw
    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        uint256 deposited = deposits[msg.sender][asset];
        uint256 actualAmount = amount > deposited ? deposited : amount;

        deposits[msg.sender][asset] -= actualAmount;
        MockERC20(asset).transfer(to, actualAmount);

        // Burn aTokens if configured
        if (address(aTokens[asset]) != address(0)) {
            aTokens[asset].burn(msg.sender, actualAmount);
        }

        emit Withdraw(asset, to, actualAmount);
        return actualAmount;
    }
}
