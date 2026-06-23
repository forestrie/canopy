import type { DelegationRequiredEvent } from "../types/delegation-required-event.js";
import { requestKeyFor } from "./request-key.js";

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

export function certificateSubmitUrlFromEnv(
  coordinatorPublicUrl: string,
): string {
  const base = coordinatorPublicUrl.replace(/\/$/, "");
  return `${base}/api/delegations/certificate`;
}

/** @deprecated use certificateSubmitUrlFromEnv */
export const materialSubmitUrlFromEnv = certificateSubmitUrlFromEnv;
