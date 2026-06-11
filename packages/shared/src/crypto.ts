import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 over the raw request body, shared verbatim by the CRM and the
 * sim so both sign/verify identically. Imported via the `@resonate/shared/
 * crypto` subpath only (never the barrel) to keep `node:crypto` out of any
 * client bundle.
 */
export function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time verification; false on any mismatch or missing signature. */
export function verifyPayload(
  secret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) {
    return false;
  }
  const expected = Buffer.from(signPayload(secret, rawBody), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
