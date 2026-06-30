/** Salt-scheme version segment in counterfactual UUPS proxy salt strings. */
export const UUPS_PROXY_SALT_SCHEME_VERSION = "v1" as const;

const UUPS_PROXY_SALT_PREFIX =
  `forestrie.eth/univocity/UUPSUnivocity/${UUPS_PROXY_SALT_SCHEME_VERSION}/` as const;

/** Normalize forest logId (UUID or hex32) to lowercase hex32 without dashes. */
export function logIdToHex32(logId: string): string {
  const stripped = logId.trim().replace(/^0x/i, "").replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(stripped)) {
    throw new Error(
      `logId must be a UUID or 32-char hex string; got ${JSON.stringify(logId)}`,
    );
  }
  return stripped.toLowerCase();
}

/** Canonical counterfactual UUPS CREATE3 salt string (ADR-0042). */
export function uupsProxySaltString(logId: string): string {
  return `${UUPS_PROXY_SALT_PREFIX}${logIdToHex32(logId)}`;
}
