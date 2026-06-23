/**
 * Forward registration enabled (kill-switch) to delegation-coordinator.
 */

export interface CoordinatorEnabledResponse {
  enabled: boolean;
}

export interface CoordinatorEnabledClientEnv {
  DELEGATION_COORDINATOR_URL?: string;
  COORDINATOR_APP_TOKEN?: string;
}

export type CoordinatorEnabledResult =
  | { ok: true; enabled: boolean }
  | { ok: false; status: number; detail: string };

function coordinatorBaseUrl(env: CoordinatorEnabledClientEnv): string | null {
  const u = env.DELEGATION_COORDINATOR_URL?.trim();
  return u ? u.replace(/\/$/, "") : null;
}

function coordinatorToken(env: CoordinatorEnabledClientEnv): string | null {
  const t = env.COORDINATOR_APP_TOKEN?.trim();
  return t || null;
}

async function parseCoordinatorEnabledResponse(
  res: Response,
): Promise<CoordinatorEnabledResult> {
  if (!res.ok) {
    let detail = await res.text();
    try {
      const json = JSON.parse(detail) as { detail?: string; title?: string };
      detail = json.detail ?? json.title ?? detail;
    } catch {
      // keep text
    }
    return { ok: false, status: res.status, detail: detail.slice(0, 500) };
  }
  const body = (await res.json()) as CoordinatorEnabledResponse;
  if (typeof body.enabled !== "boolean") {
    return {
      ok: false,
      status: 502,
      detail: "coordinator enabled response missing boolean enabled",
    };
  }
  return { ok: true, enabled: body.enabled };
}

export async function getCoordinatorEnabled(
  env: CoordinatorEnabledClientEnv,
  logUuid: string,
): Promise<CoordinatorEnabledResult> {
  const base = coordinatorBaseUrl(env);
  const token = coordinatorToken(env);
  if (!base || !token) {
    return {
      ok: false,
      status: 503,
      detail: "delegation coordinator is not configured",
    };
  }

  const res = await fetch(
    `${base}/admin/api/logs/${encodeURIComponent(logUuid)}/enabled`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return parseCoordinatorEnabledResponse(res);
}

export async function putCoordinatorEnabled(
  env: CoordinatorEnabledClientEnv,
  logUuid: string,
  enabled: boolean,
): Promise<CoordinatorEnabledResult> {
  const base = coordinatorBaseUrl(env);
  const token = coordinatorToken(env);
  if (!base || !token) {
    return {
      ok: false,
      status: 503,
      detail: "delegation coordinator is not configured",
    };
  }

  const res = await fetch(
    `${base}/admin/api/logs/${encodeURIComponent(logUuid)}/enabled`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled }),
    },
  );
  return parseCoordinatorEnabledResponse(res);
}
