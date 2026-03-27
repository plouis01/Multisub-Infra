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
): boolean {
  if (!signature || !secret) {
    throw new WebhookVerificationError(
      "Missing signature or secret for webhook verification",
    );
  }

  const expected = createHmac("sha256", secret)
    .update(body, "utf8")
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
 * Verify a webhook and parse the payload in one step.
 *
 * @param body - Raw request body string
 * @param signature - Value of the `X-MultiSubs-Signature` header
 * @param secret - Your tenant webhook secret
 * @returns Parsed webhook payload
 * @throws {WebhookVerificationError} if signature is invalid
 */
export function verifyAndParseWebhook(
  body: string,
  signature: string,
  secret: string,
): WebhookPayload {
  const valid = verifyWebhook(body, signature, secret);
  if (!valid) {
    throw new WebhookVerificationError();
  }
  return JSON.parse(body) as WebhookPayload;
}
