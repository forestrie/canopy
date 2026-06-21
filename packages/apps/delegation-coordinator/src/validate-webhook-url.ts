/**
 * Syntactic webhook URL validation at registration (no DNS resolve, no fetch).
 */

export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlValidationError";
  }
}

export interface ValidateWebhookUrlOptions {
  /** Allow http://localhost and http://127.0.0.1 when true (dev/e2e). */
  allowInsecureLocal?: boolean;
}

export function validateWebhookUrl(
  raw: string,
  options?: ValidateWebhookUrlOptions,
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WebhookUrlValidationError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebhookUrlValidationError("url must be a valid absolute URL");
  }

  const allowInsecureLocal = options?.allowInsecureLocal === true;
  const hostname = parsed.hostname.toLowerCase();
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";

  if (parsed.protocol === "https:") {
    // allowed
  } else if (allowInsecureLocal && parsed.protocol === "http:" && isLocalhost) {
    // dev/e2e only
  } else if (parsed.protocol === "http:") {
    throw new WebhookUrlValidationError("url must use https");
  } else {
    throw new WebhookUrlValidationError("url must use https");
  }

  if (isBlockedHostname(hostname)) {
    throw new WebhookUrlValidationError(
      "url hostname is not allowed for webhooks",
    );
  }

  if (isPrivateOrLoopbackIp(hostname)) {
    throw new WebhookUrlValidationError(
      "url must not target loopback or private addresses",
    );
  }

  return parsed.toString();
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return true;
  }
  return false;
}

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
