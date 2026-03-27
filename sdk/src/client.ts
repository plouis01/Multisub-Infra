import { ApiError, MultiSubsError } from "./errors.js";
import type {
  MultiSubsConfig,
  CreateUserParams,
  User,
  Balance,
  IssueCardParams,
  UpdateCardParams,
  Card,
  CardListResponse,
  TransactionListParams,
  Transaction,
  PaginatedResult,
  PaginationParams,
  YieldSummary,
  YieldSnapshot,
  CreateTenantParams,
  UpdateTenantParams,
  Tenant,
  TenantWithApiKey,
  RotateKeyResponse,
} from "./types.js";

// ============ Constants ============

const DEFAULT_BASE_URL = "https://api.multisubs.io";
const DEFAULT_TIMEOUT = 30_000;

// ============ Internal HTTP helpers ============

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

// ============ Resource Namespaces ============

class UsersResource {
  constructor(private readonly client: MultiSubsClient) {}

  /** Create a new user */
  async create(params: CreateUserParams): Promise<User> {
    return this.client._request<User>({
      method: "POST",
      path: "/v1/users",
      body: params,
    });
  }

  /** Get a user by ID */
  async get(id: string): Promise<User> {
    return this.client._request<User>({
      method: "GET",
      path: `/v1/users/${encodeURIComponent(id)}`,
    });
  }

  /** Get a user's balance */
  async getBalance(id: string): Promise<Balance> {
    return this.client._request<Balance>({
      method: "GET",
      path: `/v1/users/${encodeURIComponent(id)}/balance`,
    });
  }
}

class CardsResource {
  constructor(private readonly client: MultiSubsClient) {}

  /** Issue a new card for a user */
  async issue(userId: string, params: IssueCardParams): Promise<Card> {
    return this.client._request<Card>({
      method: "POST",
      path: `/v1/users/${encodeURIComponent(userId)}/cards`,
      body: params,
    });
  }

  /** List all cards for a user */
  async list(userId: string): Promise<Card[]> {
    const response = await this.client._request<CardListResponse>({
      method: "GET",
      path: `/v1/users/${encodeURIComponent(userId)}/cards`,
    });
    return response.cards as Card[];
  }

  /** Update a card (freeze, unfreeze, cancel, update limits) */
  async update(cardId: string, params: UpdateCardParams): Promise<Card> {
    return this.client._request<Card>({
      method: "PATCH",
      path: `/v1/cards/${encodeURIComponent(cardId)}`,
      body: params,
    });
  }
}

class TransactionsResource {
  constructor(private readonly client: MultiSubsClient) {}

  /** List transactions with optional filtering and pagination */
  async list(
    params?: TransactionListParams,
  ): Promise<PaginatedResult<Transaction>> {
    const query: Record<string, string | number | undefined> = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    if (params?.offset !== undefined) query.offset = params.offset;
    if (params?.status) query.status = params.status;
    if (params?.type) query.type = params.type;

    return this.client._request<PaginatedResult<Transaction>>({
      method: "GET",
      path: "/v1/transactions",
      query,
    });
  }

  /** Get a transaction by ID */
  async get(id: string): Promise<Transaction> {
    return this.client._request<Transaction>({
      method: "GET",
      path: `/v1/transactions/${encodeURIComponent(id)}`,
    });
  }
}

class YieldResource {
  constructor(private readonly client: MultiSubsClient) {}

  /** Get yield summary for the authenticated tenant */
  async summary(): Promise<YieldSummary> {
    return this.client._request<YieldSummary>({
      method: "GET",
      path: "/v1/yield/summary",
    });
  }

  /** List yield snapshots with pagination */
  async snapshots(
    params?: PaginationParams,
  ): Promise<PaginatedResult<YieldSnapshot>> {
    const query: Record<string, string | number | undefined> = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    if (params?.offset !== undefined) query.offset = params.offset;

    return this.client._request<PaginatedResult<YieldSnapshot>>({
      method: "GET",
      path: "/v1/yield/snapshots",
      query,
    });
  }
}

class TenantsResource {
  constructor(private readonly client: MultiSubsClient) {}

  /** Create a new tenant (admin only) */
  async create(params: CreateTenantParams): Promise<TenantWithApiKey> {
    return this.client._request<TenantWithApiKey>({
      method: "POST",
      path: "/v1/tenants",
      body: params,
    });
  }

  /** Get tenant details (admin only) */
  async get(id: string): Promise<Tenant> {
    return this.client._request<Tenant>({
      method: "GET",
      path: `/v1/tenants/${encodeURIComponent(id)}`,
    });
  }

  /** Update a tenant (admin only) */
  async update(id: string, params: UpdateTenantParams): Promise<Tenant> {
    return this.client._request<Tenant>({
      method: "PATCH",
      path: `/v1/tenants/${encodeURIComponent(id)}`,
      body: params,
    });
  }

  /** Rotate a tenant's API key (admin only) */
  async rotateKey(id: string): Promise<RotateKeyResponse> {
    return this.client._request<RotateKeyResponse>({
      method: "POST",
      path: `/v1/tenants/${encodeURIComponent(id)}/rotate-key`,
    });
  }
}

// ============ Main Client ============

export class MultiSubsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  /** User management */
  public readonly users: UsersResource;
  /** Card / sub-account management */
  public readonly cards: CardsResource;
  /** Transaction history */
  public readonly transactions: TransactionsResource;
  /** Yield information */
  public readonly yield: YieldResource;
  /** Tenant administration (requires admin API key) */
  public readonly tenants: TenantsResource;

  constructor(config: MultiSubsConfig) {
    if (!config.apiKey) {
      throw new MultiSubsError("apiKey is required");
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;

    this.users = new UsersResource(this);
    this.cards = new CardsResource(this);
    this.transactions = new TransactionsResource(this);
    this.yield = new YieldResource(this);
    this.tenants = new TenantsResource(this);
  }

  /**
   * Internal method used by resource classes to make HTTP requests.
   * @internal
   */
  async _request<T>(options: RequestOptions): Promise<T> {
    const { method, path, body, query } = options;

    // Build URL with query parameters
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(this.timeout),
    };

    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), fetchOptions);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new MultiSubsError(
          `Request to ${method} ${path} timed out after ${this.timeout}ms`,
        );
      }
      throw new MultiSubsError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Parse response body
    let responseBody: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Handle error responses
    if (!response.ok) {
      const errorObj =
        typeof responseBody === "object" && responseBody !== null
          ? (responseBody as Record<string, unknown>)
          : {};
      const message =
        typeof errorObj.error === "string"
          ? errorObj.error
          : `HTTP ${response.status} ${response.statusText}`;
      const code =
        typeof errorObj.code === "string" ? errorObj.code : undefined;
      throw new ApiError(message, response.status, code, errorObj.details);
    }

    return responseBody as T;
  }
}
