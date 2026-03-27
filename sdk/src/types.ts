// ============ SDK Configuration ============

export interface MultiSubsConfig {
  /** API key (starts with msk_) */
  apiKey: string;
  /** Base URL of the MultiSubs API. Defaults to https://api.multisubs.io */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000 */
  timeout?: number;
}

// ============ Pagination ============

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ============ Users ============

export interface CreateUserParams {
  externalId: string;
  email?: string;
  kycStatus?: "pending" | "approved" | "rejected";
}

export interface User {
  id: string;
  externalId: string;
  email: string | null;
  kycStatus: string;
  m2SafeAddress: string | null;
  eoaAddress: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string;
  subAccounts?: SubAccount[];
}

export interface Balance {
  userId: string;
  token: string;
  balance: string;
  dailySpent: string;
  monthlySpent: string;
}

// ============ Cards / Sub-Accounts ============

export interface IssueCardParams {
  type?: "virtual" | "physical";
  dailyLimit: number;
  monthlyLimit: number;
  mccBlacklist?: string[];
}

export interface UpdateCardParams {
  action?: "freeze" | "unfreeze" | "cancel";
  dailyLimit?: number;
  monthlyLimit?: number;
  mccBlacklist?: string[];
}

export interface SubAccount {
  id: string;
  type: string;
  lithicCardToken: string | null;
  dailyLimit: string;
  monthlyLimit: string;
  mccBlacklist?: string[];
  status: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Card extends SubAccount {
  lithicCard?: {
    token: string;
    type: string;
    state: string;
    lastFour: string;
  };
}

export interface CardListResponse {
  cards: SubAccount[];
}

// ============ Transactions ============

export interface TransactionListParams extends PaginationParams {
  status?:
    | "pending"
    | "approved"
    | "declined"
    | "settled"
    | "reversed"
    | "failed";
  type?: "authorization" | "settlement" | "reversal" | "deposit" | "withdrawal";
}

export interface Transaction {
  id: string;
  userId: string;
  subAccountId: string | null;
  lithicTxToken: string;
  type: string;
  amount: string;
  currency: string;
  merchantName: string | null;
  merchantMcc: string | null;
  status: string;
  onChainTxHash: string | null;
  settlementNonce?: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ============ Yield ============

export interface YieldSummary {
  totalDeposited: string;
  totalShares: string;
  unrealizedYield: string;
  apyBps: number;
  snapshotDate: string | null;
}

export interface YieldSnapshot {
  id: string;
  snapshotDate: string;
  totalDeposited: string;
  totalShares: string;
  totalYield: string;
  apyBps: number;
  createdAt: string;
}

// ============ Tenants (Admin) ============

export interface CreateTenantParams {
  name: string;
  custodyModel?: "MODEL_A" | "MODEL_B";
  webhookUrl?: string;
  rateLimit?: number;
}

export interface UpdateTenantParams {
  webhookUrl?: string | null;
  rateLimit?: number;
  status?: "active" | "suspended" | "disabled";
}

export interface Tenant {
  id: string;
  name: string;
  custodyModel: string;
  webhookUrl: string | null;
  rateLimit: number;
  status: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TenantWithApiKey extends Tenant {
  apiKey: string;
}

export interface RotateKeyResponse {
  tenantId: string;
  apiKey: string;
  message: string;
}

// ============ Webhook Events ============

export type WebhookEventType =
  | "card.authorization.approved"
  | "card.authorization.declined"
  | "card.transaction.settled"
  | "card.transaction.reversed"
  | "deposit.received"
  | "withdrawal.initiated"
  | "withdrawal.completed"
  | "yield.distributed";

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  tenantId: string;
  timestamp: number;
  data: Record<string, unknown>;
}
