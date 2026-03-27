import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.js";
import type { WebhookPayload } from "./types.js";

/**
 * Verify an incoming webhook request from MultiSubs.
 *
 * Computes HMAC-SHA256 over the raw request body using the shared webhook
 * secret and compares it to the provided signature using constant-time
 * comparison to prevent timing attacks.
 *
 * @param body - Raw request body string (do NOT parse JSON first)
 * @param signature - Value of the `X-MultiSubs-Signature` header
 * @param secret - Your tenant webhook secret
 * @returns `true` if the signature is valid
 * @throws {WebhookVerificationError} if signature is missing or invalid
 */
export function verifyWebhook(
  body: string,
  signature: string,
  secret: string,
  timestamp?: string,
): boolean {
  if (!signature || !secret) {
    throw new WebhookVerificationError(
      "Missing signature or secret for webhook verification",
    );
  }

  // If timestamp provided, include it in verification (matches backend format)
  const signatureInput = timestamp ? `${timestamp}.${body}` : body;

  const expected = createHmac("sha256", secret)
    .update(signatureInput, "utf8")
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Verify a webhook with timestamp staleness checking.
 *
 * @param body - Raw request body string
 * @param signature - Value of the `X-MultiSubs-Signature` header
 * @param secret - Your tenant webhook secret
 * @param timestamp - Value of the `X-Webhook-Timestamp` header
 * @param maxAgeSeconds - Maximum allowed age in seconds (default 300)
 * @returns `true` if the signature is valid and timestamp is fresh
 * @throws {WebhookVerificationError} if timestamp is stale or invalid
 */
export function verifyWebhookWithTimestamp(
  body: string,
  signature: string,
  secret: string,
  timestamp: string,
  maxAgeSeconds = 300,
): boolean {
  // Check timestamp staleness
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) throw new WebhookVerificationError("Invalid timestamp");
  const age = Math.floor(Date.now() / 1000) - ts;
  if (age > maxAgeSeconds)
    throw new WebhookVerificationError(
      `Webhook too old: ${age}s > ${maxAgeSeconds}s`,
    );
  if (age < -60)
    throw new WebhookVerificationError("Webhook timestamp is in the future");

  return verifyWebhook(body, signature, secret, timestamp);
}

/**
 * Verify a webhook and parse the payload in one step.
 *
 * @param body - Raw request body string
 * @param signature - Value of the `X-MultiSubs-Signature` header
 * @param secret - Your tenant webhook secret
 * @param timestamp - Optional value of the `X-Webhook-Timestamp` header
 * @returns Parsed webhook payload
 * @throws {WebhookVerificationError} if signature is invalid
 */
export function verifyAndParseWebhook(
  body: string,
  signature: string,
  secret: string,
  timestamp?: string,
): WebhookPayload {
  const valid = timestamp
    ? verifyWebhookWithTimestamp(body, signature, secret, timestamp)
    : verifyWebhook(body, signature, secret);
  if (!valid) {
    throw new WebhookVerificationError();
  }
  return JSON.parse(body) as WebhookPayload;
}
