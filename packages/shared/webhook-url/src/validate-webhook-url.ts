/**
 * Syntactic webhook URL validation (no DNS resolve, no fetch).
 * Used before persisting callback URLs on register-statement / grant flows.
 */

import { WebhookUrlValidationError } from "./webhook-url-validation-error.js";
import type { ValidateWebhookUrlOptions } from "./validate-webhook-url-options.js";

/**
 * Parse and validate a webhook URL for safe outbound use.
 *
 * @param raw - User-supplied URL string
 * @param options - Dev localhost allowance and error field label
 * @returns Canonical URL string (`URL#toString()`)
 * @throws {@link WebhookUrlValidationError} when protocol, host, or IP rules fail
 */
export function validateWebhookUrl(
  raw: string,
  options?: ValidateWebhookUrlOptions,
): string {
  const field = options?.fieldLabel ?? "url";
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WebhookUrlValidationError(`${field} is required`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebhookUrlValidationError(
      `${field} must be a valid absolute URL`,
    );
  }

  const allowInsecureLocal = options?.allowInsecureLocal === true;
  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";

  if (parsed.protocol === "https:") {
    // allowed
  } else if (allowInsecureLocal && parsed.protocol === "http:" && isLocalhost) {
    // dev/e2e only
  } else if (parsed.protocol === "http:") {
    throw new WebhookUrlValidationError(`${field} must use https`);
  } else {
    throw new WebhookUrlValidationError(`${field} must use https`);
  }

  if (isBlockedHostname(hostname)) {
    throw new WebhookUrlValidationError(
      `${field} hostname is not allowed for webhooks`,
    );
  }

  if (!(allowInsecureLocal && isLocalhost) && isPrivateOrLoopbackIp(hostname)) {
    throw new WebhookUrlValidationError(
      `${field} must not target loopback or private addresses`,
    );
  }

  return parsed.toString();
}

/** Reject internal DNS suffixes unsuitable for public webhooks. */
function isBlockedHostname(hostname: string): boolean {
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return true;
  }
  return false;
}

/** Detect loopback and RFC1918/link-local IPv4 literals in the hostname. */
function isPrivateOrLoopbackIp(hostname: string): boolean {
  if (hostname.includes(":")) {
    return isPrivateOrLoopbackIpv6(hostname);
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }
  const parts = hostname.split(".").map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

/** Detect loopback and ULA/link-local IPv6 literals in the hostname. */
function isPrivateOrLoopbackIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  return false;
}
