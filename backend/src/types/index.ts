import { z } from "zod";

// ============ Custody Models ============

export const CustodyModel = {
  MODEL_A: "MODEL_A", // Managed Treasury (platform controls funds)
  MODEL_B: "MODEL_B", // Self-Custody Vaults (user controls funds)
} as const;

export type CustodyModel = (typeof CustodyModel)[keyof typeof CustodyModel];

// ============ Authorization ============

export interface AuthorizationRequest {
  lithicTxToken: string;
  cardToken: string;
  amount: number; // cents
  merchantName: string;
  merchantMcc: string;
  merchantCity?: string;
  merchantCountry?: string;
  currency: string;
}

export interface AuthorizationResult {
  approved: boolean;
  reason?: string;
  balanceAfter?: string;
}

// ============ Authorization Cache (Redis) ============

export interface AuthorizationCache {
  eoaAddress: string;
  m2SafeAddress: string;
  tenantId: string;
  usdcBalance: string; // 6-decimal string
  dailySpent: string;
  dailyLimit: string;
  monthlySpent: string;
  monthlyLimit: string;
  lastUpdated: number; // unix timestamp ms
}

// ============ Card Mapping (Redis) ============

export interface CardMapping {
  subAccountId: string;
  tenantId: string;
  eoaAddress: string;
  m2SafeAddress: string;
  status: "active" | "frozen" | "cancelled";
}

// ============ Settlement ============

export interface SettlementJob {
  lithicTxToken: string;
  m2SafeAddress: string;
  issuerSafeAddress: string;
  amount: string; // USDC 6-decimal string
  tenantId: string;
  attempt: number;
  createdAt: number;
}

// ============ Webhook Events ============

export const WebhookEventType = {
  CARD_AUTH_APPROVED: "card.authorization.approved",
  CARD_AUTH_DECLINED: "card.authorization.declined",
  CARD_TX_SETTLED: "card.transaction.settled",
  CARD_TX_REVERSED: "card.transaction.reversed",
  DEPOSIT_RECEIVED: "deposit.received",
  WITHDRAWAL_INITIATED: "withdrawal.initiated",
  WITHDRAWAL_COMPLETED: "withdrawal.completed",
  YIELD_DISTRIBUTED: "yield.distributed",
} as const;

export type WebhookEventType =
  (typeof WebhookEventType)[keyof typeof WebhookEventType];

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  tenantId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ============ Zod Schemas for API Validation ============

export const CreateUserSchema = z.object({
  externalId: z.string().min(1).max(255),
  email: z.string().email().optional(),
  kycStatus: z.enum(["pending", "approved", "rejected"]).default("pending"),
});

export const IssueCardSchema = z.object({
  type: z.enum(["virtual", "physical"]).default("virtual"),
  dailyLimit: z.number().int().positive().max(100_000_00), // cents, max $100k
  monthlyLimit: z.number().int().positive().max(1_000_000_00), // cents, max $1M
  mccBlacklist: z.array(z.string().length(4)).optional(),
});

export const DepositSchema = z.object({
  amount: z.string().regex(/^\d+$/, "Must be a non-negative integer string"),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

// ============ Lithic ASA Webhook Types ============

export interface LithicASAEvent {
  token: string;
  card_token: string;
  status: "AUTHORIZATION" | "AUTHORIZATION_ADVICE" | "CLEARING" | "VOID";
  amount: number; // cents
  merchant: {
    descriptor: string;
    mcc: string;
    city?: string;
    country?: string;
  };
  created: string; // ISO 8601
}

export type LithicASAResponse = {
  result: "APPROVED" | "DECLINED";
};
