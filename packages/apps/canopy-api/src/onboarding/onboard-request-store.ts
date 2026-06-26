import type { OnboardRequestRecord } from "./onboard-request-record.js";
import type { OnboardRequestStatus } from "./onboard-request-status.js";
import {
  generateRedeemCode,
  hashRedeemCode,
  onboardRequestR2Key,
} from "./onboard-request-hash.js";

export interface OnboardRequestStoreEnv {
  R2_GRANTS: R2Bucket;
}

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

export interface CreateOnboardRequestInput {
  label: string;
  chainBinding: OnboardRequestRecord["chainBinding"];
  contactEmail: string;
  mandateOrigin?: string;
  plannedForestR?: string;
  ttlSec: number;
}

export interface CreateOnboardRequestResult {
  record: OnboardRequestRecord;
  redeemCode: string;
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
  await env.R2_GRANTS.put(onboardRequestR2Key(requestId), encodeRecord(record), {
    httpMetadata: { contentType: "application/json" },
  });
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

export async function listOnboardRequests(
  env: OnboardRequestStoreEnv,
): Promise<OnboardRequestRecord[]> {
  const listed = await env.R2_GRANTS.list({ prefix: "onboarding/requests/" });
  const out: OnboardRequestRecord[] = [];
  for (const obj of listed.objects) {
    const got = await env.R2_GRANTS.get(obj.key);
    if (!got) continue;
    const record = decodeRecord(new Uint8Array(await got.arrayBuffer()));
    if (record) out.push(record);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function effectiveStatus(
  record: OnboardRequestRecord,
  nowSec = Math.floor(Date.now() / 1000),
): OnboardRequestStatus {
  if (
    record.status === "pending" &&
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
  return hash === record.redeemCodeHash;
}

export { hashRedeemCode, generateRedeemCode };
