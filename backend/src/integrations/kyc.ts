import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

// ============ Constants ============

const DEFAULT_BASE_URL = "https://api.sumsub.com";
const REQUEST_TIMEOUT_MS = 15_000;

// ============ Types ============

export type KycReviewStatus =
  | "init"
  | "pending"
  | "queued"
  | "completed"
  | "onHold";

export type KycReviewResult = "GREEN" | "RED" | "YELLOW";

export interface KycApplicant {
  id: string;
  externalUserId: string;
  email?: string;
  status: KycReviewStatus;
  createdAt: string;
}

export interface KycStatus {
  reviewStatus: KycReviewStatus;
  reviewResult?: { reviewAnswer: KycReviewResult };
  createDate: string;
}

export interface KycWebhookEvent {
  applicantId: string;
  externalUserId: string;
  type:
    | "applicantReviewed"
    | "applicantPending"
    | "applicantCreated"
    | "applicantOnHold";
  reviewResult?: { reviewAnswer: KycReviewResult };
  createdAt: string;
}

// ============ Errors ============

export class SumsubApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "SumsubApiError";
  }
}

export class SumsubWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SumsubWebhookError";
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
        service: "sumsub",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  warn: (msg, meta) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        service: "sumsub",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
  error: (msg, meta) =>
    console.error(
      JSON.stringify({
        level: "error",
        service: "sumsub",
        msg,
        ...meta,
        ts: new Date().toISOString(),
      }),
    ),
};

// ============ SumsubClient ============

export class SumsubClient {
  protected readonly baseUrl: string;
  protected readonly logger: Logger;

  constructor(
    protected readonly appToken: string,
    protected readonly secretKey: string,
    baseUrl?: string,
    logger?: Logger,
  ) {
    if (!appToken) {
      throw new Error("Sumsub app token is required");
    }
    if (!secretKey) {
      throw new Error("Sumsub secret key is required");
    }

    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.logger = logger ?? defaultLogger;

    this.logger.info("SumsubClient initialized", {
      baseUrl: this.baseUrl,
    });
  }

  // ---------- Create Applicant ----------

  async createApplicant(params: {
    externalUserId: string;
    email?: string;
    levelName?: string;
  }): Promise<KycApplicant> {
    const body: Record<string, unknown> = {
      externalUserId: params.externalUserId,
    };
    if (params.email) {
      body.email = params.email;
    }

    const queryParams = params.levelName
      ? `?levelName=${encodeURIComponent(params.levelName)}`
      : "";

    this.logger.info("Creating applicant", {
      externalUserId: params.externalUserId,
    });

    const response = await this.request<Record<string, unknown>>(
      "POST",
      `/resources/applicants${queryParams}`,
      body,
    );

    const applicant: KycApplicant = {
      id: response.id as string,
      externalUserId: response.externalUserId as string,
      email: response.email as string | undefined,
      status:
        ((response.review as Record<string, unknown>)
          ?.reviewStatus as KycReviewStatus) ?? "init",
      createdAt: response.createdAt as string,
    };

    this.logger.info("Applicant created", {
      applicantId: applicant.id,
      externalUserId: applicant.externalUserId,
    });

    return applicant;
  }

  // ---------- Get Applicant ----------

  async getApplicant(applicantId: string): Promise<KycApplicant> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    this.logger.info("Fetching applicant", { applicantId });

    const response = await this.request<Record<string, unknown>>(
      "GET",
      `/resources/applicants/${encodeURIComponent(applicantId)}`,
    );

    const applicant: KycApplicant = {
      id: response.id as string,
      externalUserId: response.externalUserId as string,
      email: response.email as string | undefined,
      status:
        ((response.review as Record<string, unknown>)
          ?.reviewStatus as KycReviewStatus) ?? "init",
      createdAt: response.createdAt as string,
    };

    return applicant;
  }

  // ---------- Get Applicant Status ----------

  async getApplicantStatus(applicantId: string): Promise<KycStatus> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    this.logger.info("Fetching applicant status", { applicantId });

    const response = await this.request<Record<string, unknown>>(
      "GET",
      `/resources/applicants/${encodeURIComponent(applicantId)}/status`,
    );

    const status: KycStatus = {
      reviewStatus: response.reviewStatus as KycReviewStatus,
      createDate: response.createDate as string,
    };

    if (response.reviewResult) {
      status.reviewResult = response.reviewResult as {
        reviewAnswer: KycReviewResult;
      };
    }

    return status;
  }

  // ---------- Create Access Token ----------

  async createAccessToken(
    externalUserId: string,
    levelName?: string,
  ): Promise<{ token: string; userId: string }> {
    if (!externalUserId) {
      throw new Error("External user ID is required");
    }

    const queryParts = [`userId=${encodeURIComponent(externalUserId)}`];
    if (levelName) {
      queryParts.push(`levelName=${encodeURIComponent(levelName)}`);
    }
    const queryString = `?${queryParts.join("&")}`;

    this.logger.info("Creating access token", { externalUserId });

    const response = await this.request<Record<string, unknown>>(
      "POST",
      `/resources/accessTokens${queryString}`,
    );

    return {
      token: response.token as string,
      userId: response.userId as string,
    };
  }

  // ---------- Reset Applicant ----------

  async resetApplicant(applicantId: string): Promise<void> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    this.logger.info("Resetting applicant", { applicantId });

    await this.request<unknown>(
      "POST",
      `/resources/applicants/${encodeURIComponent(applicantId)}/reset`,
    );

    this.logger.info("Applicant reset", { applicantId });
  }

  // ---------- Webhook Signature Verification ----------

  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!payload || !signature) {
      return false;
    }

    try {
      const expectedSig = createHmac("sha256", this.secretKey)
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
      const ts = Math.floor(Date.now() / 1000).toString();
      const bodyString = body !== undefined ? JSON.stringify(body) : "";

      // HMAC-SHA256 signature: ts + method + path + body
      const sigPayload = ts + method.toUpperCase() + path + bodyString;
      const sig = createHmac("sha256", this.secretKey)
        .update(sigPayload, "utf8")
        .digest("hex");

      const headers: Record<string, string> = {
        "X-App-Token": this.appToken,
        "X-App-Access-Sig": sig,
        "X-App-Access-Ts": ts,
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? bodyString : undefined,
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
        this.logger.error("Sumsub API error", {
          method,
          path,
          status: response.status,
          body: parsed,
        });
        throw new SumsubApiError(
          `Sumsub API ${method} ${path} returned ${response.status}`,
          response.status,
          parsed,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof SumsubApiError) {
        throw error;
      }

      const isAbort =
        error instanceof DOMException && error.name === "AbortError";
      if (isAbort) {
        this.logger.error("Sumsub API request timed out", {
          method,
          path,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        throw new SumsubApiError(
          `Sumsub API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
          0,
          null,
        );
      }

      this.logger.error("Sumsub API network error", {
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new SumsubApiError(
        `Sumsub API ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============ MockSumsubClient ============

interface MockApplicant {
  id: string;
  externalUserId: string;
  email?: string;
  reviewStatus: KycReviewStatus;
  reviewResult?: { reviewAnswer: KycReviewResult };
  createdAt: string;
}

export class MockSumsubClient extends SumsubClient {
  private readonly applicants = new Map<string, MockApplicant>();
  private readonly externalIdToApplicantId = new Map<string, string>();
  private applicantCounter = 0;

  constructor(secretKey = "test-sumsub-secret", logger?: Logger) {
    super("mock-app-token", secretKey, DEFAULT_BASE_URL, logger);
  }

  // ---------- Deterministic ID generation ----------

  private generateApplicantId(): string {
    this.applicantCounter += 1;
    return `mock-applicant-${String(this.applicantCounter).padStart(6, "0")}`;
  }

  // ---------- Overrides ----------

  override async createApplicant(params: {
    externalUserId: string;
    email?: string;
    levelName?: string;
  }): Promise<KycApplicant> {
    // Return existing applicant if already created for this externalUserId
    const existingId = this.externalIdToApplicantId.get(params.externalUserId);
    if (existingId) {
      const existing = this.applicants.get(existingId)!;
      return {
        id: existing.id,
        externalUserId: existing.externalUserId,
        email: existing.email,
        status: existing.reviewStatus,
        createdAt: existing.createdAt,
      };
    }

    const id = this.generateApplicantId();
    const now = new Date().toISOString();

    const applicant: MockApplicant = {
      id,
      externalUserId: params.externalUserId,
      email: params.email,
      reviewStatus: "init",
      createdAt: now,
    };

    this.applicants.set(id, applicant);
    this.externalIdToApplicantId.set(params.externalUserId, id);

    this.logger.info("Mock applicant created", {
      applicantId: id,
      externalUserId: params.externalUserId,
    });

    return {
      id: applicant.id,
      externalUserId: applicant.externalUserId,
      email: applicant.email,
      status: applicant.reviewStatus,
      createdAt: applicant.createdAt,
    };
  }

  override async getApplicant(applicantId: string): Promise<KycApplicant> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    const applicant = this.applicants.get(applicantId);
    if (!applicant) {
      throw new SumsubApiError(`Applicant not found: ${applicantId}`, 404, {
        message: "Applicant not found",
      });
    }

    return {
      id: applicant.id,
      externalUserId: applicant.externalUserId,
      email: applicant.email,
      status: applicant.reviewStatus,
      createdAt: applicant.createdAt,
    };
  }

  override async getApplicantStatus(applicantId: string): Promise<KycStatus> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    const applicant = this.applicants.get(applicantId);
    if (!applicant) {
      throw new SumsubApiError(`Applicant not found: ${applicantId}`, 404, {
        message: "Applicant not found",
      });
    }

    const status: KycStatus = {
      reviewStatus: applicant.reviewStatus,
      createDate: applicant.createdAt,
    };

    if (applicant.reviewResult) {
      status.reviewResult = { ...applicant.reviewResult };
    }

    return status;
  }

  override async createAccessToken(
    externalUserId: string,
    _levelName?: string,
  ): Promise<{ token: string; userId: string }> {
    if (!externalUserId) {
      throw new Error("External user ID is required");
    }

    return {
      token: `mock-access-token-${externalUserId}`,
      userId: externalUserId,
    };
  }

  override async resetApplicant(applicantId: string): Promise<void> {
    if (!applicantId) {
      throw new Error("Applicant ID is required");
    }

    const applicant = this.applicants.get(applicantId);
    if (!applicant) {
      throw new SumsubApiError(`Applicant not found: ${applicantId}`, 404, {
        message: "Applicant not found",
      });
    }

    applicant.reviewStatus = "init";
    applicant.reviewResult = undefined;

    this.logger.info("Mock applicant reset", { applicantId });
  }

  // ---------- Test helpers ----------

  /** Generate a valid HMAC-SHA256 signature for a payload (useful in tests). */
  signPayload(payload: string): string {
    return createHmac("sha256", this.secretKey)
      .update(payload, "utf8")
      .digest("hex");
  }

  /** Simulate approving an applicant (GREEN result). */
  approveApplicant(applicantId: string): void {
    const applicant = this.applicants.get(applicantId);
    if (!applicant) {
      throw new Error(`Applicant not found: ${applicantId}`);
    }
    applicant.reviewStatus = "completed";
    applicant.reviewResult = { reviewAnswer: "GREEN" };
  }

  /** Simulate rejecting an applicant (RED result). */
  rejectApplicant(applicantId: string): void {
    const applicant = this.applicants.get(applicantId);
    if (!applicant) {
      throw new Error(`Applicant not found: ${applicantId}`);
    }
    applicant.reviewStatus = "completed";
    applicant.reviewResult = { reviewAnswer: "RED" };
  }

  /** Build a synthetic webhook event for testing. */
  buildWebhookEvent(overrides: Partial<KycWebhookEvent> = {}): KycWebhookEvent {
    return {
      applicantId: overrides.applicantId ?? "mock-applicant-000001",
      externalUserId: overrides.externalUserId ?? "ext-user-001",
      type: overrides.type ?? "applicantReviewed",
      reviewResult: overrides.reviewResult ?? { reviewAnswer: "GREEN" },
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    };
  }

  /** Return the number of applicants currently tracked. */
  get applicantCount(): number {
    return this.applicants.size;
  }

  /** Reset all in-memory state. */
  reset(): void {
    this.applicants.clear();
    this.externalIdToApplicantId.clear();
    this.applicantCounter = 0;
  }
}
