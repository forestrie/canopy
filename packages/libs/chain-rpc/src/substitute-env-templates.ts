/**
 * Inline `${env:VAR}` substitution for deploy-time RPC URL resolution.
 * Same escape rules as univocity-tools `evaluateOptionValue`; consumed by
 * `parseSupportedChainsRpc` and `resolve-for-deploy.mjs` so Doppler secrets
 * land in `SUPPORTED_CHAINS_RPC` before the Worker boots — see
 * [ADR-0010](https://github.com/forestrie/canopy/blob/main/docs/adr/adr-0010-supported-chains-rpc-config.md).
 */

/** Sentinel replacing escaped `\\${env:` during the substitution pass. */
const LITERAL_ENV_PREFIX = "\u0000LIT_ENV\u0000";

/** Matches unescaped `${env:VAR}` tokens in RPC URL strings. */
const INLINE_ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Name → value map used when resolving templates (typically Doppler / CI env). */
export type EnvRecord = Record<string, string | undefined>;

/**
 * Substitute `${env:VAR}` tokens inline. Escaped `\\${env:VAR}` stays literal.
 *
 * @param raw - String possibly containing `${env:VAR}` placeholders.
 * @param env - Variables available for substitution.
 * @returns String with placeholders replaced by env values.
 * @throws When a referenced variable is missing or empty.
 */
export function substituteEnvTemplates(raw: string, env: EnvRecord): string {
  const escaped = raw.replace(/\\\$\{env:/g, LITERAL_ENV_PREFIX);
  const substituted = escaped.replace(
    INLINE_ENV_PATTERN,
    (_match, varName: string) => {
      const value = env[varName];
      if (value === undefined || value.length === 0) {
        throw new Error(`Missing environment variable: ${varName}`);
      }
      return value;
    },
  );
  return substituted.replaceAll(LITERAL_ENV_PREFIX, "${env:");
}
