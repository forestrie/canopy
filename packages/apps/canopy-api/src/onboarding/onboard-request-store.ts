import type { OnboardRequestRecord } from "./onboard-request-record.js";
import type { OnboardRequestStatus } from "./onboard-request-status.js";
import type { CreateOnboardRequestInput } from "./create-onboard-request.js";
import type { CreateOnboardRequestResult } from "./create-onboard-request.js";
import type { ListOnboardRequestsResult } from "./list-onboard-requests-result.js";
import type { OnboardRequestStoreEnv } from "./onboard-request-store-env.js";
import type { OnboardRequestWithEtag } from "./onboard-request-with-etag.js";
import type { PendingTransitionCasResult } from "./pending-transition-cas-result.js";
import type { RedeemCasResult } from "./redeem-cas-result.js";
import {
  generateRedeemCode,
  hashRedeemCode,
  onboardRequestR2Key,
} from "./onboard-request-hash.js";
import { secureHexEqual } from "./secure-hex-equal.js";

export type {
  CreateOnboardRequestInput,
  CreateOnboardRequestResult,
  ListOnboardRequestsResult,
  OnboardRequestStoreEnv,
  OnboardRequestWithEtag,
  PendingTransitionCasResult,
  RedeemCasResult,
} from "./types.js";

function encodeRecord(record: OnboardRequestRecord): string {
  return JSON.stringify(record);
}

function decodeRecord(bytes: Uint8Array): OnboardRequestRecord | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as OnboardRequestRecord;
    if (
      typeof parsed.requestId !== "string" ||
      typeof parsed.status !== "string" ||
      typeof parsed.redeemCodeHash !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function recordEtag(obj: R2ObjectBody): string {
  return obj.etag;
}

async function putRecordCas(
  env: OnboardRequestStoreEnv,
  record: OnboardRequestRecord,
  etag: string,
): Promise<boolean> {
  const written = await env.R2_GRANTS.put(
    onboardRequestR2Key(record.requestId),
    encodeRecord(record),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagMatches: etag },
    },
  );
  return written != null;
}

export async function createOnboardRequest(
  env: OnboardRequestStoreEnv,
  input: CreateOnboardRequestInput,
): Promise<CreateOnboardRequestResult> {
  const requestId = crypto.randomUUID();
  const redeemCode = generateRedeemCode();
  const redeemCodeHash = await hashRedeemCode(redeemCode);
  const now = Math.floor(Date.now() / 1000);
  const record: OnboardRequestRecord = {
    requestId,
    status: "pending",
    label: input.label,
    chainBinding: input.chainBinding,
    contactEmail: input.contactEmail,
    mandateOrigin: input.mandateOrigin,
    plannedForestR: input.plannedForestR,
    redeemCodeHash,
    createdAt: now,
    expiresAt: now + input.ttlSec,
  };
  await env.R2_GRANTS.put(
    onboardRequestR2Key(requestId),
    encodeRecord(record),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  return { record, redeemCode };
}

export async function readOnboardRequest(
  env: OnboardRequestStoreEnv,
  requestId: string,
): Promise<OnboardRequestRecord | null> {
  const got = await env.R2_GRANTS.get(onboardRequestR2Key(requestId));
  if (!got) return null;
  return decodeRecord(new Uint8Array(await got.arrayBuffer()));
}

export async function readOnboardRequestWithEtag(
  env: OnboardRequestStoreEnv,
  requestId: string,
): Promise<OnboardRequestWithEtag | null> {
  const got = await env.R2_GRANTS.get(onboardRequestR2Key(requestId));
  if (!got) return null;
  const record = decodeRecord(new Uint8Array(await got.arrayBuffer()));
  if (!record) return null;
  return { record, etag: recordEtag(got) };
}

export async function writeOnboardRequest(
  env: OnboardRequestStoreEnv,
  record: OnboardRequestRecord,
): Promise<void> {
  await env.R2_GRANTS.put(
    onboardRequestR2Key(record.requestId),
    encodeRecord(record),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function countNonTerminalRequestsForBinding(
  env: OnboardRequestStoreEnv,
  chainId: string,
  univocityAddr: string,
): Promise<number> {
  const listed = await env.R2_GRANTS.list({ prefix: "onboarding/requests/" });
  let count = 0;
  for (const obj of listed.objects) {
    const got = await env.R2_GRANTS.get(obj.key);
    if (!got) continue;
    const record = decodeRecord(new Uint8Array(await got.arrayBuffer()));
    if (!record) continue;
    const status = effectiveStatus(record);
    if (status !== "pending" && status !== "approved") continue;
    if (
      record.chainBinding.chainId === chainId &&
      record.chainBinding.univocityAddr === univocityAddr
    ) {
      count++;
    }
  }
  return count;
}

export async function listOnboardRequests(
  env: OnboardRequestStoreEnv,
  options: { limit?: number; cursor?: string } = {},
): Promise<ListOnboardRequestsResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const listed = await env.R2_GRANTS.list({
    prefix: "onboarding/requests/",
    limit,
    cursor: options.cursor,
  });
  const out: OnboardRequestRecord[] = [];
  for (const obj of listed.objects) {
    const got = await env.R2_GRANTS.get(obj.key);
    if (!got) continue;
    const record = decodeRecord(new Uint8Array(await got.arrayBuffer()));
    if (record) out.push(record);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return {
    requests: out,
    cursor: listed.truncated ? listed.cursor : undefined,
  };
}

export function effectiveStatus(
  record: OnboardRequestRecord,
  nowSec = Math.floor(Date.now() / 1000),
): OnboardRequestStatus {
  if (
    (record.status === "pending" || record.status === "approved") &&
    record.expiresAt <= nowSec
  ) {
    return "expired";
  }
  return record.status;
}

export async function verifyRedeemCode(
  record: OnboardRequestRecord,
  presented: string,
): Promise<boolean> {
  const hash = await hashRedeemCode(presented.trim());
  return secureHexEqual(hash, record.redeemCodeHash);
}

export async function transitionPendingToApprovedCas(
  env: OnboardRequestStoreEnv,
  requestId: string,
): Promise<PendingTransitionCasResult> {
  const current = await readOnboardRequestWithEtag(env, requestId);
  if (!current) return { ok: false, reason: "not_found" };
  const status = effectiveStatus(current.record);
  if (status !== "pending") {
    return { ok: false, reason: "wrong_state" };
  }
  const approved: OnboardRequestRecord = {
    ...current.record,
    status: "approved",
  };
  const ok = await putRecordCas(env, approved, current.etag);
  if (!ok) return { ok: false, reason: "cas_failed" };
  return { ok: true, record: approved };
}

export async function transitionPendingToRejectedCas(
  env: OnboardRequestStoreEnv,
  requestId: string,
  rejectReason?: string,
): Promise<PendingTransitionCasResult> {
  const current = await readOnboardRequestWithEtag(env, requestId);
  if (!current) return { ok: false, reason: "not_found" };
  const status = effectiveStatus(current.record);
  if (status !== "pending") {
    return { ok: false, reason: "wrong_state" };
  }
  const rejected: OnboardRequestRecord = {
    ...current.record,
    status: "rejected",
    rejectReason,
  };
  const ok = await putRecordCas(env, rejected, current.etag);
  if (!ok) return { ok: false, reason: "cas_failed" };
  return { ok: true, record: rejected };
}

export async function transitionApprovedToRedeemedCas(
  env: OnboardRequestStoreEnv,
  requestId: string,
): Promise<RedeemCasResult> {
  const current = await readOnboardRequestWithEtag(env, requestId);
  if (!current) return { ok: false, reason: "not_found" };
  const status = effectiveStatus(current.record);
  if (status !== "approved") {
    return { ok: false, reason: "wrong_state" };
  }
  const redeemed: OnboardRequestRecord = {
    ...current.record,
    status: "redeemed",
    redeemedAt: Math.floor(Date.now() / 1000),
  };
  const ok = await putRecordCas(env, redeemed, current.etag);
  if (!ok) return { ok: false, reason: "cas_failed" };
  return { ok: true, record: redeemed };
}

export { hashRedeemCode, generateRedeemCode };
