import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LithicASAEvent } from "../types/index.js";

// ============ Constants ============

const BASE_URLS = {
  sandbox: "https://sandbox.lithic.com/v1",
  production: "https://api.lithic.com/v1",
} as const;

const REQUEST_TIMEOUT_MS = 15_000;

// ============ Types ============

export type LithicEnvironment = "sandbox" | "production";

export interface LithicCardDetails {
  token: string;
  type: "VIRTUAL" | "PHYSICAL";
  state:
    | "OPEN"
    | "PAUSED"
    | "CLOSED"
    | "PENDING_ACTIVATION"
    | "PENDING_FULFILLMENT";
  spend_limit: number;
  memo: string;
  pan?: string;
  cvv?: string;
  exp_month?: string;
  exp_year?: string;
  last_four: string;
  created: string;
}

export interface CreateCardParams {
  type: "virtual" | "physical";
  spendLimit: number; // cents
  memo?: string;
}

export interface UpdateCardParams {
  state?: "OPEN" | "PAUSED" | "CLOSED";
  spendLimit?: number; // cents
}

// ============ Zod Schemas ============

const LithicMerchantSchema = z.object({
  descriptor: z.string(),
  mcc: z.string(),
  city: z.string().optional(),
  country: z.string().optional(),
});

const LithicASAEventSchema = z.object({
  token: z.string().min(1),
  card_token: z.string().min(1),
  status: z.enum(["AUTHORIZATION", "AUTHORIZATION_ADVICE", "CLEARING", "VOID"]),
  amount: z.number().int(),
  merchant: LithicMerchantSchema,
  created: z.string().datetime({ offset: true }),
});

const LithicCardResponseSchema = z.object({
  token: z.string(),
  type: z.enum(["VIRTUAL", "PHYSICAL", "MERCHANT_LOCKED", "SINGLE_USE"]),
  state: z.enum([
    "OPEN",
    "PAUSED",
    "CLOSED",
    "PENDING_ACTIVATION",
    "PENDING_FULFILLMENT",
  ]),
  spend_limit: z.number(),
  memo: z.string().default(""),
  pan: z.string().optional(),
  cvv: z.string().optional(),
  exp_month: z.string().optional(),
  exp_year: z.string().optional(),
  last_four: z.string().default("0000"),
  created: z.string(),
});

// ============ Errors ============

export class LithicApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "LithicApiError";
  }
}

export class LithicWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LithicWebhookError";
  }
}

// ============ Logger ============

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: Logger = {
  info: (msg, meta) =>
    console.log(
      JSON.stringify({
        level: "info",
        service: "lithic",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "lithic",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "lithic",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ============ LithicClient ============

export class LithicClient {
  protected readonly baseUrl: string;
  protected readonly logger: Logger;

  constructor(
    protected readonly apiKey: string,
    protected readonly webhookSecret: string,
    protected readonly environment: LithicEnvironment,
    logger?: Logger,
  ) {
    if (!apiKey) {
      throw new Error("Lithic API key is required");
    }
    if (!webhookSecret) {
      throw new Error("Lithic webhook secret is required");
    }

    this.baseUrl = BASE_URLS[environment];
    this.logger = logger ?? defaultLogger;

    this.logger.info("LithicClient initialized", {
      environment,
      baseUrl: this.baseUrl,
    });
  }

  // ---------- Card Issuance ----------

  async createCard(params: CreateCardParams): Promise<LithicCardDetails> {
    const body = {
      type: params.type === "virtual" ? "VIRTUAL" : "PHYSICAL",
      spend_limit: params.spendLimit,
      spend_limit_duration: "TRANSACTION",
      memo: params.memo ?? "",
      state: "OPEN",
    };

    this.logger.info("Creating card", {
      type: body.type,
      spendLimit: body.spend_limit,
    });

    const response = await this.request<unknown>("POST", "/cards", body);
    const card = LithicCardResponseSchema.parse(response);

    this.logger.info("Card created", {
      token: card.token,
      type: card.type,
      state: card.state,
    });

    return card as LithicCardDetails;
  }

  // ---------- Card Retrieval ----------

  async getCard(cardToken: string): Promise<LithicCardDetails> {
    if (!cardToken) {
      throw new Error("Card token is required");
    }

    this.logger.info("Fetching card", { cardToken });

    const response = await this.request<unknown>(
      "GET",
      `/cards/${encodeURIComponent(cardToken)}`,
    );
    const card = LithicCardResponseSchema.parse(response);

    return card as LithicCardDetails;
  }

  // ---------- Card Updates (freeze / unfreeze / cancel / spend limit) ----------

  async updateCard(
    cardToken: string,
    params: UpdateCardParams,
  ): Promise<LithicCardDetails> {
    if (!cardToken) {
      throw new Error("Card token is required");
    }

    const body: Record<string, unknown> = {};
    if (params.state !== undefined) {
      body.state = params.state;
    }
    if (params.spendLimit !== undefined) {
      body.spend_limit = params.spendLimit;
    }

    this.logger.info("Updating card", { cardToken, ...params });

    const response = await this.request<unknown>(
      "PATCH",
      `/cards/${encodeURIComponent(cardToken)}`,
      body,
    );
    const card = LithicCardResponseSchema.parse(response);

    this.logger.info("Card updated", {
      token: card.token,
      state: card.state,
      spendLimit: card.spend_limit,
    });

    return card as LithicCardDetails;
  }

  // ---------- Webhook Signature Verification ----------

  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!payload || !signature) {
      return false;
    }

    try {
      const expectedSig = createHmac("sha256", this.webhookSecret)
        .update(payload, "utf8")
        .digest("hex");

      const sigBuffer = Buffer.from(signature, "hex");
      const expectedBuffer = Buffer.from(expectedSig, "hex");

      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }

      return timingSafeEqual(sigBuffer, expectedBuffer);
    } catch {
      this.logger.warn(
        "Webhook signature verification failed due to malformed input",
      );
      return false;
    }
  }

  // ---------- ASA Event Parsing ----------

  parseASAEvent(body: unknown): LithicASAEvent {
    const result = LithicASAEventSchema.safeParse(body);

    if (!result.success) {
      this.logger.error("Failed to parse ASA event", {
        errors: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      throw new LithicWebhookError(
        `Invalid ASA event payload: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }

    this.logger.info("Parsed ASA event", {
      token: result.data.token,
      cardToken: result.data.card_token,
      status: result.data.status,
      amount: result.data.amount,
    });

    return result.data;
  }

  // ---------- HTTP Transport ----------

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        Authorization: `api-key ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const responseBody = await response.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = responseBody;
      }

      if (!response.ok) {
        this.logger.error("Lithic API error", {
          method,
          path,
          status: response.status,
          body: parsed,
        });
        throw new LithicApiError(
          `Lithic API ${method} ${path} returned ${response.status}`,
          response.status,
          parsed,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof LithicApiError) {
        throw error;
      }

      const isAbort =
        error instanceof DOMException && error.name === "AbortError";
      if (isAbort) {
        this.logger.error("Lithic API request timed out", {
          method,
          path,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        throw new LithicApiError(
          `Lithic API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
          null,
        );
      }

      this.logger.error("Lithic API network error", {
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new LithicApiError(
        `Lithic API ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============ MockLithicClient ============

interface MockCard {
  token: string;
  type: "VIRTUAL" | "PHYSICAL";
  state:
    | "OPEN"
    | "PAUSED"
    | "CLOSED"
    | "PENDING_ACTIVATION"
    | "PENDING_FULFILLMENT";
  spend_limit: number;
  memo: string;
  pan: string;
  cvv: string;
  exp_month: string;
  exp_year: string;
  last_four: string;
  created: string;
}

export class MockLithicClient extends LithicClient {
  private readonly cards = new Map<string, MockCard>();
  private cardCounter = 0;

  constructor(webhookSecret = "test-webhook-secret", logger?: Logger) {
    super("mock-api-key", webhookSecret, "sandbox", logger);
  }

  // ---------- Deterministic token generation ----------

  private generateCardToken(): string {
    this.cardCounter += 1;
    return `mock-card-${String(this.cardCounter).padStart(6, "0")}`;
  }

  private generatePan(): string {
    // Generate a predictable 16-digit PAN based on counter
    const suffix = String(this.cardCounter).padStart(12, "0");
    return `4000${suffix}`;
  }

  // ---------- Overrides ----------

  override async createCard(
    params: CreateCardParams,
  ): Promise<LithicCardDetails> {
    const token = this.generateCardToken();
    const pan = this.generatePan();
    const now = new Date().toISOString();

    const card: MockCard = {
      token,
      type: params.type === "virtual" ? "VIRTUAL" : "PHYSICAL",
      state: params.type === "physical" ? "PENDING_FULFILLMENT" : "OPEN",
      spend_limit: params.spendLimit,
      memo: params.memo ?? "",
      pan,
      cvv: "123",
      exp_month: "12",
      exp_year: "2028",
      last_four: pan.slice(-4),
      created: now,
    };

    this.cards.set(token, card);

    this.logger.info("Mock card created", {
      token,
      type: card.type,
      state: card.state,
    });

    return { ...card };
  }

  override async getCard(cardToken: string): Promise<LithicCardDetails> {
    if (!cardToken) {
      throw new Error("Card token is required");
    }

    const card = this.cards.get(cardToken);
    if (!card) {
      throw new LithicApiError(`Card not found: ${cardToken}`, 404, {
        message: "Card not found",
      });
    }

    return { ...card };
  }

  override async updateCard(
    cardToken: string,
    params: UpdateCardParams,
  ): Promise<LithicCardDetails> {
    if (!cardToken) {
      throw new Error("Card token is required");
    }

    const card = this.cards.get(cardToken);
    if (!card) {
      throw new LithicApiError(`Card not found: ${cardToken}`, 404, {
        message: "Card not found",
      });
    }

    if (card.state === "CLOSED") {
      throw new LithicApiError("Cannot update a closed card", 400, {
        message: "Card is closed",
      });
    }

    if (params.state !== undefined) {
      card.state = params.state;
    }
    if (params.spendLimit !== undefined) {
      card.spend_limit = params.spendLimit;
    }

    this.logger.info("Mock card updated", {
      token: card.token,
      state: card.state,
      spendLimit: card.spend_limit,
    });

    return { ...card };
  }

  // ---------- Helpers for tests ----------

  /** Generate a valid HMAC-SHA256 signature for a payload (useful in tests). */
  signPayload(payload: string): string {
    return createHmac("sha256", this.webhookSecret)
      .update(payload, "utf8")
      .digest("hex");
  }

  /** Build a synthetic ASA event for testing. */
  buildASAEvent(overrides: Partial<LithicASAEvent> = {}): LithicASAEvent {
    return {
      token: overrides.token ?? randomUUID(),
      card_token: overrides.card_token ?? "mock-card-000001",
      status: overrides.status ?? "AUTHORIZATION",
      amount: overrides.amount ?? 1500,
      merchant: overrides.merchant ?? {
        descriptor: "ACME WIDGETS",
        mcc: "5411",
        city: "SAN FRANCISCO",
        country: "US",
      },
      created: overrides.created ?? new Date().toISOString(),
    };
  }

  /** Return the number of cards currently tracked. */
  get cardCount(): number {
    return this.cards.size;
  }

  /** Reset all in-memory state. */
  reset(): void {
    this.cards.clear();
    this.cardCounter = 0;
  }
}
