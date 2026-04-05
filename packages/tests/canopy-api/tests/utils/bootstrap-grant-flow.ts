import type { APIRequestContext } from "@playwright/test";
import { decode } from "cbor-x";
import { attachReceiptAndIdtimestampToTransparentStatement } from "../../../../apps/canopy-api/src/scrapi/attach-scitt-transparent-statement-receipt.js";
import { custodianBootstrapSignEnv } from "./custodian-bootstrap-sign";
import { assertBootstrapMintE2eEnv } from "./e2e-env-guards";
import { entryIdHexToIdtimestampBe8 } from "./entry-id-e2e";
import { mintTransparentBootstrapGrantBase64 } from "./mint-bootstrap-grant-e2e.js";
import {
  completeGrantRegistrationThroughReceipt,
  type CompleteGrantRegistrationThroughReceiptResult,
} from "./register-grant-through-receipt";

export { mintTransparentBootstrapGrantBase64 };

/** Plan 0014 / `transparent-statement.ts`: full grant v0 CBOR in unprotected header. */
const HEADER_FORESTRIE_GRANT_V0 = -65538;

export const DEFAULT_ROOT_LOG_ID = "123e4567-e89b-12d3-a456-426614174000";

function toHeaderMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (typeof raw === "object" && raw !== null && !(raw instanceof Uint8Array)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

/**
 * Assert base64 body matches Custodian Forestrie-Grant wire: COSE Sign1, 32-byte
 * digest payload, unprotected -65538 carries grant v0 CBOR.
 */
export function assertCustodianProfileTransparentStatement(
  base64: string,
): void {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const sign1 = decode(bytes) as unknown;
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    throw new Error("Expected untagged COSE Sign1 (CBOR array of 4 elements)");
  }
  const payload = sign1[2];
  if (!(payload instanceof Uint8Array) || payload.length !== 32) {
    throw new Error(
      "Expected COSE payload to be 32-byte SHA-256 digest (Custodian profile)",
    );
  }
  const sig = sign1[3];
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new Error(
      "Expected COSE ES256 signature bstr to be 64-byte IEEE P1363 (not KMS DER)",
    );
  }
  const unprotected = toHeaderMap(sign1[1]);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      `Expected unprotected header ${HEADER_FORESTRIE_GRANT_V0} (grant v0 CBOR bytes)`,
    );
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/**
 * Bootstrap mint for e2e: `POST /api/forest/{log-id}/genesis` + Custodian `:bootstrap` sign
 * (Plan 0019). **Throws** if `CURATOR_ADMIN_TOKEN` or Custodian bootstrap env is missing.
 */
export async function mintBootstrapGrantPlaywright(
  unauthorizedRequest: APIRequestContext,
  rootLogId: string,
): Promise<string> {
  assertBootstrapMintE2eEnv();
  const curator = process.env.CURATOR_ADMIN_TOKEN!.trim();
  const boot = custodianBootstrapSignEnv()!;

  return mintTransparentBootstrapGrantBase64({
    request: unauthorizedRequest,
    rootLogId,
    curatorToken: curator,
    custodianUrl: boot.baseUrl,
    custodianBootstrapToken: boot.token,
  });
}

export interface CompleteBootstrapGrantWithReceiptOptions {
  unauthorizedRequest: APIRequestContext;
  logId: string;
  baseURL: string;
  grantBase64: string;
  ladderMs?: number[];
  pollRegistrationMaxMs?: number;
  resolveReceiptMaxMs?: number;
}

export type CompleteBootstrapGrantWithReceiptResult =
  CompleteGrantRegistrationThroughReceiptResult;

/**
 * POST register-grant, poll until receipt redirect, GET receipt until 200.
 */
export async function completeBootstrapGrantWithReceipt(
  opts: CompleteBootstrapGrantWithReceiptOptions,
): Promise<CompleteBootstrapGrantWithReceiptResult> {
  return completeGrantRegistrationThroughReceipt({
    unauthorizedRequest: opts.unauthorizedRequest,
    bootstrapLogId: opts.logId,
    baseURL: opts.baseURL,
    grantBase64: opts.grantBase64,
    ladderMs: opts.ladderMs,
    pollRegistrationMaxMs: opts.pollRegistrationMaxMs,
    resolveReceiptMaxMs: opts.resolveReceiptMaxMs,
  });
}

export function buildCompletedGrantBase64(
  grantBase64: string,
  receiptBytes: Uint8Array,
  entryIdHex: string,
): string {
  const grantBytes = base64ToBytes(grantBase64);
  const idtimestampBe8 = entryIdHexToIdtimestampBe8(entryIdHex);
  const completedBytes = attachReceiptAndIdtimestampToTransparentStatement(
    grantBytes,
    receiptBytes,
    idtimestampBe8,
  );
  return bytesToForestrieGrantBase64(completedBytes);
}

export { shouldSkipSequencingPoll } from "./e2e-env-guards";
