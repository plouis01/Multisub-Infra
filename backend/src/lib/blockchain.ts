import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import type { Config } from "../config/index.js";

// ============ SpendSettler ABI (minimal for settlement) ============

export const SPEND_SETTLER_ABI = parseAbi([
  "function settle(uint256 amount, bytes32 lithicTxToken) external",
  "function isSettled(bytes32 lithicTxToken) external view returns (bool)",
  "function getRollingSpend() external view returns (uint256)",
  "function getTotalSettled() external view returns (uint256)",
  "function nonce() external view returns (uint256)",
  "event SpendSettled(address indexed m2Safe, address indexed issuerSafe, uint256 amount, bytes32 indexed lithicTxToken, uint256 nonce)",
]);

// ============ ERC20 ABI (USDC) ============

export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// ============ Client Factory ============

function getChain(chainId: number): Chain {
  switch (chainId) {
    case 8453:
      return base;
    case 84532:
      return baseSepolia;
    default:
      return baseSepolia;
  }
}

export function createBlockchainClients(config: Config): {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
} {
  const chain = getChain(config.chainId);

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  let walletClient: WalletClient | null = null;
  if (config.settlerPrivateKey) {
    const account = privateKeyToAccount(
      config.settlerPrivateKey as `0x${string}`,
    );
    walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl),
    });
  }

  return { publicClient, walletClient };
}

// ============ USDC Helpers ============

export async function getUsdcBalance(
  publicClient: PublicClient,
  usdcAddress: string,
  accountAddress: string,
): Promise<bigint> {
  return publicClient.readContract({
    address: usdcAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [accountAddress as `0x${string}`],
  }) as Promise<bigint>;
}
