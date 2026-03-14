/**
 * Univocity REST client (Subplan 02). Used for "logId initialized?" (bootstrap branch).
 * Do not use for inclusion verification — use univocal checkpoint from contracts (8.5a).
 */

export interface UnivocityRestEnv {
  univocityServiceUrl: string;
}

/**
 * GET /api/root — returns { exists, rootLogId }.
 */
export async function getRoot(
  env: UnivocityRestEnv,
): Promise<{ exists: boolean; rootLogId: string | null }> {
  const base = env.univocityServiceUrl?.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("UNIVOCITY_SERVICE_URL not configured");
  }
  const res = await fetch(`${base}/api/root`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Univocity GET /api/root failed: ${res.status}`);
  }
  const data = (await res.json()) as { exists?: boolean; rootLogId?: string };
  return {
    exists: data.exists === true,
    rootLogId: data.rootLogId?.trim() ?? null,
  };
}

/**
 * GET /api/logs/{logId}/config — returns 200 with config or 404 when log not initialized.
 */
export async function getLogConfig(
  logId: string,
  env: UnivocityRestEnv,
): Promise<{ kind: string; authLogId: string; initializedAt: number } | null> {
  const base = env.univocityServiceUrl?.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error("UNIVOCITY_SERVICE_URL not configured");
  }
  const res = await fetch(`${base}/api/logs/${encodeURIComponent(logId)}/config`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Univocity GET /api/logs/config failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    kind?: string;
    authLogId?: string;
    initializedAt?: number;
  };
  return {
    kind: data.kind ?? "undefined",
    authLogId: data.authLogId ?? "",
    initializedAt: data.initializedAt ?? 0,
  };
}

/**
 * True if the log is initialized on chain (config exists).
 */
export async function isLogInitialized(
  logId: string,
  env: UnivocityRestEnv,
): Promise<boolean> {
  const config = await getLogConfig(logId, env);
  return config !== null;
}
