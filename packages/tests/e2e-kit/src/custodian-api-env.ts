/**
 * Env guards for direct Custodian HTTP e2e (`CUSTODIAN_URL`, app tokens).
 */

/** Trailing-slash–normalized Custodian URL from env (legacy / display). */
export function custodianApiTrimBaseUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

/**
 * Origin (scheme + host [+ port]) for Traefik **root** ops routes:
 * `/healthz`, `/readyz`, `/version`, `/metrics`.
 * Ignores any path on `CUSTODIAN_URL` (e.g. `/v1` is not used for ops).
 */
export function custodianApiOpsBaseUrl(resolvedCustodianUrl: string): string {
  const raw = resolvedCustodianUrl.trim();
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withProto);
  return `${u.protocol}//${u.host}`;
}

/**
 * Public API base: `{origin}/v1`. Traefik matches `/v1/api/…` and stripPrefix `/v1`
 * so the pod receives `/api/…`.
 */
export function custodianApiV1BaseUrl(resolvedCustodianUrl: string): string {
  return `${custodianApiOpsBaseUrl(resolvedCustodianUrl)}/v1`;
}

export function custodianApiBaseUrl(): string | null {
  const u = process.env.CUSTODIAN_URL?.trim();
  return u ? custodianApiTrimBaseUrl(u) : null;
}

export function custodianApiAppToken(): string | null {
  const t = process.env.CUSTODIAN_APP_TOKEN?.trim();
  return t || null;
}

/** Bootstrap **app token** for privileged routes (e.g. `POST .../delete`), not the `:bootstrap` KMS key. */
export function custodianApiBootstrapAppToken(): string | null {
  const t = process.env.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim();
  return t || null;
}

export function assertCustodianApiE2eEnv(): {
  baseUrl: string;
  appToken: string;
} {
  const baseUrl = custodianApiBaseUrl();
  const appToken = custodianApiAppToken();
  if (!baseUrl || !appToken) {
    throw new Error(
      "Custodian API e2e requires CUSTODIAN_URL and CUSTODIAN_APP_TOKEN (see packages/tests/canopy-api/README.md).",
    );
  }
  return { baseUrl, appToken };
}

export function hasCustodianApiE2eEnv(): boolean {
  return Boolean(custodianApiBaseUrl() && custodianApiAppToken());
}
