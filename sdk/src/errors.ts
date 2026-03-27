// ============ Base Error ============

/**
 * Base error class for all MultiSubs SDK errors.
 */
export class MultiSubsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiSubsError";
    // Maintain proper stack trace for V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ============ API Error ============

/**
 * Error returned by the MultiSubs API.
 * Contains the HTTP status code and optional error code from the response.
 */
export class ApiError extends MultiSubsError {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly details: unknown;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True if this was a 4xx client error */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** True if this was a 5xx server error */
  get isServerError(): boolean {
    return this.status >= 500;
  }

  /** True if rate-limited (429) */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

// ============ Webhook Verification Error ============

/**
 * Error thrown when webhook signature verification fails.
 */
export class WebhookVerificationError extends MultiSubsError {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
