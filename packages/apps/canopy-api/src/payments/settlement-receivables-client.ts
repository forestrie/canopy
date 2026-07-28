/**
 * Server-side read of x402-settlement's `/admin/receivables/{id}` (FOR-497).
 *
 * ADR-0059 D6 keeps canopy-api's data plane off the ReceivablesDO — this
 * client is the deliberate, narrow exception for the owner-facing account
 * read: canopy-api fronts the ops route with its own operator token (the
 * same shared identity as the kill-switch path) and exposes only the
 * owner-relevant fields, after the caller has proven holder-of-bootstrap-key.
 */

import type {
  SettlementReceivablesClientEnv,
  SettlementReceivablesRead,
  SettlementReceivablesResult,
} from "./settlement-receivables-result.js";

export type {
  SettlementReceivablesClientEnv,
  SettlementReceivablesRead,
  SettlementReceivablesResult,
} from "./settlement-receivables-result.js";

interface AdminReceivablesBody {
  entitlement?: {
    creditsBalance?: unknown;
    checkpointsAccrued?: unknown;
    arrears?: unknown;
    enforcementFrozen?: unknown;
    registrationBlock?: unknown;
  } | null;
  watermarkBlock?: unknown;
}

function toRead(body: AdminReceivablesBody): SettlementReceivablesRead | null {
  const e = body.entitlement;
  if (
    !e ||
    typeof e.creditsBalance !== "number" ||
    typeof e.checkpointsAccrued !== "number" ||
    typeof e.arrears !== "string" ||
    typeof e.enforcementFrozen !== "boolean"
  ) {
    return null;
  }
  const read: SettlementReceivablesRead = {
    creditsBalance: e.creditsBalance,
    checkpointsAccrued: e.checkpointsAccrued,
    arrears: e.arrears,
    enforcementFrozen: e.enforcementFrozen,
    watermarkBlock:
      typeof body.watermarkBlock === "number" ? body.watermarkBlock : null,
  };
  if (e.registrationBlock === null || typeof e.registrationBlock === "number") {
    read.registrationBlock = e.registrationBlock;
  }
  return read;
}

export async function getSettlementReceivables(
  env: SettlementReceivablesClientEnv,
  univocityInstanceId: string,
): Promise<SettlementReceivablesResult> {
  const base = env.X402_SETTLEMENT_URL?.trim().replace(/\/$/, "");
  const token = env.CANOPY_OPS_ADMIN_TOKEN?.trim();
  if (!base || !token) {
    return {
      ok: false,
      status: 503,
      detail: "x402-settlement receivables read is not configured",
    };
  }

  let res: Response;
  try {
    res = await fetch(
      `${base}/admin/receivables/${encodeURIComponent(univocityInstanceId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    return {
      ok: false,
      status: 502,
      detail: `receivables read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 404) {
    return { ok: false, status: 404, detail: "no account state for instance" };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ok: false,
      status: 502,
      detail: detail || `upstream ${res.status}`,
    };
  }

  let body: AdminReceivablesBody;
  try {
    body = (await res.json()) as AdminReceivablesBody;
  } catch {
    return { ok: false, status: 502, detail: "receivables read: invalid JSON" };
  }
  const read = toRead(body);
  if (!read) {
    // A watermark with no entitlement is not an owner-relevant account yet.
    return { ok: false, status: 404, detail: "no account state for instance" };
  }
  return { ok: true, read };
}
