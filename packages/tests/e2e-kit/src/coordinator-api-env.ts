/**
 * Env guards for delegation-coordinator HTTP e2e.
 */

export function delegationCoordinatorBaseUrl(): string | null {
  const u = process.env.DELEGATION_COORDINATOR_URL?.trim();
  return u ? u.replace(/\/$/, "") : null;
}

export function coordinatorAppToken(): string | null {
  const t = process.env.COORDINATOR_APP_TOKEN?.trim();
  return t || null;
}

export function hasCoordinatorApiE2eEnv(): boolean {
  return Boolean(delegationCoordinatorBaseUrl() && coordinatorAppToken());
}

export function assertCoordinatorApiE2eEnv(): {
  baseUrl: string;
  appToken: string;
} {
  const baseUrl = delegationCoordinatorBaseUrl();
  const appToken = coordinatorAppToken();
  if (!baseUrl || !appToken) {
    throw new Error(
      "Coordinator API e2e requires DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN " +
        "(see packages/tests/canopy-api/README.md).",
    );
  }
  return { baseUrl, appToken };
}
