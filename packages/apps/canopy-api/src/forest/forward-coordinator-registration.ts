/**
 * One-shot coordinator registration during genesis: public-root + webhook (plan-0037).
 * Brokers with canopy's COORDINATOR_APP_TOKEN so onboard-token holders need not hold it.
 */

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import { logIdToStorageSegment } from "../grant/log-id-wire.js";
import type { CoordinatorRegistrationStatus } from "./coordinator-registration-status.js";

export interface CoordinatorForwardEnv {
  DELEGATION_COORDINATOR_URL?: string;
  COORDINATOR_APP_TOKEN?: string;
}

export interface ForwardCoordinatorRegistrationInput {
  coordinatorBaseUrl: string;
  coordinatorAppToken: string;
  logIdWire: Uint8Array;
  genesisAlg: number;
  bootstrapKey: Uint8Array;
  /**
   * Sealer-nudge webhook to register for this log. Optional: child onboarding
   * (ADR-0053 auto-forward / prepare) registers only the public root — the gate
   * `handlePutCertificate` needs — and has no per-log webhook to inherit, so it
   * is omitted and the webhook step is reported `skipped`.
   */
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

interface PublicRootJsonBody {
  alg: "ES256" | number;
  x?: string;
  y?: string;
  key?: string;
}

export function isCoordinatorForwardConfigured(
  env: CoordinatorForwardEnv,
): boolean {
  return Boolean(
    env.DELEGATION_COORDINATOR_URL?.trim() && env.COORDINATOR_APP_TOKEN?.trim(),
  );
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i]!);
  }
  return btoa(binary);
}

export function buildCoordinatorPublicRootBody(
  genesisAlg: number,
  bootstrapKey: Uint8Array,
): PublicRootJsonBody {
  if (genesisAlg === COSE_ALG_ES256) {
    if (bootstrapKey.length !== 64) {
      throw new Error("ES256 bootstrapKey must be 64 bytes (x||y)");
    }
    return {
      alg: "ES256",
      x: bytesToBase64(bootstrapKey.slice(0, 32)),
      y: bytesToBase64(bootstrapKey.slice(32, 64)),
    };
  }
  if (genesisAlg === COSE_ALG_KS256) {
    if (bootstrapKey.length !== 20) {
      throw new Error("KS256 bootstrapKey must be 20 bytes");
    }
    return {
      alg: COSE_ALG_KS256,
      key: bytesToBase64(bootstrapKey),
    };
  }
  throw new Error(`unsupported genesisAlg ${genesisAlg}`);
}

async function postPublicRoot(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  apiLogId: string,
  body: PublicRootJsonBody,
): Promise<Response> {
  return fetchImpl(`${baseUrl}/api/logs/${apiLogId}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function putWebhook(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  apiLogId: string,
  webhookUrl: string,
): Promise<Response> {
  return fetchImpl(`${baseUrl}/api/logs/${apiLogId}/webhook`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url: webhookUrl }),
  });
}

/**
 * Register public-root then webhook on the delegation coordinator.
 * Assumes publicRoot == K(L) == genesis bootstrapKey (Mode B/C single-hop).
 */
export async function forwardCoordinatorRegistration(
  input: ForwardCoordinatorRegistrationInput,
): Promise<CoordinatorRegistrationStatus> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.coordinatorBaseUrl.trim().replace(/\/$/, "");
  const token = input.coordinatorAppToken.trim();
  const apiLogId = logIdToStorageSegment(input.logIdWire);

  const status: CoordinatorRegistrationStatus = {
    publicRoot: "error",
    webhook: "skipped",
  };

  let publicRootBody: PublicRootJsonBody;
  try {
    publicRootBody = buildCoordinatorPublicRootBody(
      input.genesisAlg,
      input.bootstrapKey,
    );
  } catch (error) {
    status.detail =
      error instanceof Error ? error.message : "invalid bootstrap key";
    return status;
  }

  try {
    const rootResp = await postPublicRoot(
      fetchImpl,
      baseUrl,
      token,
      apiLogId,
      publicRootBody,
    );
    if (!rootResp.ok) {
      status.detail = `public-root returned ${rootResp.status}`;
      return status;
    }
    status.publicRoot = "ok";
  } catch (error) {
    status.detail =
      error instanceof Error ? error.message : "public-root request failed";
    return status;
  }

  // No webhook to register (e.g. child onboarding): public root is done, webhook
  // stays `skipped`.
  const webhookUrl = input.webhookUrl?.trim();
  if (!webhookUrl) {
    return status;
  }

  try {
    const hookResp = await putWebhook(
      fetchImpl,
      baseUrl,
      token,
      apiLogId,
      webhookUrl,
    );
    if (!hookResp.ok) {
      status.webhook = "error";
      status.detail = `webhook returned ${hookResp.status}`;
      return status;
    }
    status.webhook = "ok";
    return status;
  } catch (error) {
    status.webhook = "error";
    status.detail =
      error instanceof Error ? error.message : "webhook request failed";
    return status;
  }
}
