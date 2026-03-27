// ============ @multisubs/sdk ============

// Client
export { MultiSubsClient } from "./client.js";

// Webhook helpers
export {
  verifyWebhook,
  verifyWebhookWithTimestamp,
  verifyAndParseWebhook,
} from "./webhook.js";

// Errors
export {
  MultiSubsError,
  ApiError,
  WebhookVerificationError,
} from "./errors.js";

// Types — re-export everything
export type {
  MultiSubsConfig,
  PaginationParams,
  PaginatedResult,
  CreateUserParams,
  User,
  Balance,
  IssueCardParams,
  UpdateCardParams,
  Card,
  CardListResponse,
  SubAccount,
  TransactionListParams,
  Transaction,
  YieldSummary,
  YieldSnapshot,
  CreateTenantParams,
  UpdateTenantParams,
  Tenant,
  TenantWithApiKey,
  RotateKeyResponse,
  WebhookEventType,
  WebhookPayload,
} from "./types.js";
