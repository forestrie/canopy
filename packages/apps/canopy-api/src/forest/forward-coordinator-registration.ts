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
   * `delegation.required` webhook to register for this log — the endpoint the
   * delegation coordinator calls to ask this log's owner to sign a delegation
   * (ADR-0005 delegation webhook delivery). This is **not** the sealer nudge:
   * that is a separate mechanism, ranger publishing seal hints, specified in
   * arbor ADR-0007 low-latency-sealer-trigger.
   *
   * Optional by design. A log with no webhook — directly or inherited from its
   * univocity instance — is never asked, and its owner must supply the
   * delegation pre-emptively instead. Child onboarding (ADR-0053 auto-forward /
   * prepare) registers only the public root, the gate `handlePutCertificate`
   * needs, so the webhook step is reported `skipped`.
   */
  webhookUrl?: string;
  /**
   * Univocity instance this log belongs to — the canonical CAIP-10
   * `univocityInstanceId` (ADR-0059 decision 7).
   *
   * Registering it binds the log to its instance, and the coordinator **copies**
   * the instance-level webhook into this log's own config row (ADR-0005
   * amendment, FOR-468). That is what lets an owner who operates many logs
   * register one webhook instead of one per log. If the instance has no webhook
   * the binding is still recorded — the log then has none, and a later instance
   * re-point reaches it.
   */
  univocityInstanceId?: string;
  /**
   * Bound each coordinator request with an `AbortSignal`, in milliseconds.
   *
   * Genesis without an explicit `webhookUrl` forwards **best-effort** — the
   * result is reported and never acted on — so it must not be able to hold
   * genesis open on a slow or unreachable coordinator. Non-fatal is not the
   * same as non-blocking (FOR-468 review, H2).
   *
   * Omitted leaves the request unbounded, which is the pre-existing behaviour
   * of the strict path: there a failure is already fatal with a 503, so the
   * caller learns something either way.
   */
  timeoutMs?: number;
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

/** `AbortSignal` for a bounded request, or undefined when unbounded. */
function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return typeof timeoutMs === "number" && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

async function postPublicRoot(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  apiLogId: string,
  body: PublicRootJsonBody,
  timeoutMs?: number,
): Promise<Response> {
  return fetchImpl(`${baseUrl}/api/logs/${apiLogId}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  });
}

async function putWebhook(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  apiLogId: string,
  body: { url?: string; univocityInstanceId?: string },
  timeoutMs?: number,
): Promise<Response> {
  return fetchImpl(`${baseUrl}/api/logs/${apiLogId}/webhook`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
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
      input.timeoutMs,
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

  // Nothing to register — neither an explicit webhook nor an instance to
  // inherit one from. Public root is done; the webhook step stays `skipped`.
  const webhookUrl = input.webhookUrl?.trim();
  const univocityInstanceId = input.univocityInstanceId?.trim();
  if (!webhookUrl && !univocityInstanceId) {
    return status;
  }
  if (univocityInstanceId) {
    status.univocityInstanceId = univocityInstanceId;
  }

  try {
    const hookResp = await putWebhook(
      fetchImpl,
      baseUrl,
      token,
      apiLogId,
      {
        ...(webhookUrl ? { url: webhookUrl } : {}),
        ...(univocityInstanceId ? { univocityInstanceId } : {}),
      },
      input.timeoutMs,
    );
    if (!hookResp.ok) {
      status.webhook = "error";
      status.detail = `webhook returned ${hookResp.status}`;
      return status;
    }
    // An explicit URL is `ok`; a bare instance binding is `inherited` — the log
    // gets whatever webhook the instance has, which may legitimately be none.
    status.webhook = webhookUrl ? "ok" : "inherited";
    return status;
  } catch (error) {
    status.webhook = "error";
    status.detail =
      error instanceof Error ? error.message : "webhook request failed";
    return status;
  }
}
