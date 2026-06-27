/**
 * Build `delegation.required` webhook events for pending BYOK certificates.
 *
 * Upstream: {@link DelegationStoreDO} when issue finds no stored certificate.
 * Downstream: signed delivery via {@link deliverSignedWebhook}; operators
 * submit certificates to POST /api/delegations/certificate. Flow aligns with
 * [arbor sealer pending](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * delegation surfacing per
 * [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import type { DelegationRequiredEvent } from "../types/delegation-required-event.js";
import { requestKeyFor } from "./request-key.js";

/** Inputs for constructing a delegation.required webhook payload. */
export interface BuildDelegationRequiredEventInput {
  logIdHex32: string;
  authLogIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKeyBase64: string;
  delegatedPubkeyHash: string;
  requestedAt: number;
  certificateSubmitUrl: string;
}

/**
 * Build a idempotent delegation.required event for webhook delivery.
 *
 * @param input - Pending delegation fields and submit URL.
 * @returns Event ready for JSON serialization and signing.
 */
export async function buildDelegationRequiredEvent(
  input: BuildDelegationRequiredEventInput,
): Promise<DelegationRequiredEvent> {
  const requestKey = await requestKeyFor(
    input.logIdHex32,
    input.mmrStart,
    input.mmrEnd,
    input.delegatedPubkeyHash,
  );
  return {
    requestKey,
    type: "delegation.required",
    version: 1,
    logId: input.logIdHex32,
    authLogId: input.authLogIdHex32,
    mmrStart: input.mmrStart,
    mmrEnd: input.mmrEnd,
    delegatedPublicKey: input.delegatedPublicKeyBase64,
    requestedAt: input.requestedAt,
    certificateSubmitUrl: input.certificateSubmitUrl,
    materialSubmitUrl: input.certificateSubmitUrl,
  };
}

/**
 * Absolute URL for runner certificate submission from coordinator public base.
 *
 * @param coordinatorPublicUrl - {@link Env.COORDINATOR_PUBLIC_URL} or default.
 * @returns POST /api/delegations/certificate URL.
 */
export function certificateSubmitUrlFromEnv(
  coordinatorPublicUrl: string,
): string {
  const base = coordinatorPublicUrl.replace(/\/$/, "");
  return `${base}/api/delegations/certificate`;
}

/** @deprecated use certificateSubmitUrlFromEnv */
export const materialSubmitUrlFromEnv = certificateSubmitUrlFromEnv;
