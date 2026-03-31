// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IDeFiInteractor
 * @notice Interface for the M1 Treasury DeFi execution module
 * @dev Targets Morpho vault operations and Aave v3 supply/withdraw only
 */
interface IDeFiInteractor {
    // ============ Events ============

    event MorphoDeposit(address indexed vault, uint256 assets, uint256 shares);
    event MorphoWithdraw(address indexed vault, uint256 assets, uint256 sharesBurned);
    event MorphoRedeem(address indexed vault, uint256 shares, uint256 assetsReceived);
    event AaveSupply(address indexed pool, address indexed asset, uint256 amount);
    event AaveWithdraw(address indexed pool, address indexed asset, uint256 amount, uint256 withdrawn);
    event VaultAllowlisted(address indexed vault);
    event VaultRemoved(address indexed vault);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event TreasuryVaultUpdated(address indexed oldVault, address indexed newVault);
    event RewardsClaimed(address indexed distributor);

    // ============ Morpho Operations ============

    function depositToMorpho(address vault, uint256 assets, uint256 minShares) external returns (uint256 shares);
    function withdrawFromMorpho(address vault, uint256 assets, uint256 maxSharesBurned)
        external
        returns (uint256 sharesBurned);
    function redeemFromMorpho(address vault, uint256 shares, uint256 minAssetsOut)
        external
        returns (uint256 assetsReceived);

    // ============ Aave Operations ============

    function supplyToAave(address pool, address asset, uint256 amount) external;
    function withdrawFromAave(address pool, address asset, uint256 amount, uint256 minReceived)
        external
        returns (uint256 withdrawn);

    // ============ Admin Functions ============

    function addAllowlistedVault(address vault) external;
    function removeAllowlistedVault(address vault) external;
    function setOperator(address newOperator) external;
    function setTreasuryVault(address _treasuryVault) external;

    // ============ View Functions ============

    function isAllowlistedVault(address vault) external view returns (bool);
    function operator() external view returns (address);
    function treasuryVault() external view returns (address);
}
