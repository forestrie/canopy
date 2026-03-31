import type { APIRequestContext, TestInfo } from "@playwright/test";
import { decode } from "cbor-x";
import { attachReceiptAndIdtimestampToTransparentStatement } from "../../../../apps/canopy-api/src/scrapi/attach-scitt-transparent-statement-receipt.js";
import { expectAPI as expect } from "../fixtures/auth";
import {
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  sequencingBackoff,
} from "./arithmetic-backoff-poll";
import { skipOrThrowIfBootstrapMintUnconfigured } from "./bootstrap-e2e-guard";
import { postRegisterGrantExpect303 } from "./bootstrap-grant-setup";
import { entryIdHexToIdtimestampBe8 } from "./entry-id-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./problem-details";

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

export type MintBootstrapGrantResult =
  | { skipped: true }
  | { skipped: false; grantBase64: string };

/**
 * POST /api/grants/bootstrap. On unconfigured deployment, may skip per
 * {@link skipOrThrowIfBootstrapMintUnconfigured}.
 */
export async function mintBootstrapGrantPlaywright(
  unauthorizedRequest: APIRequestContext,
  rootLogId: string,
  testInfo: TestInfo,
): Promise<MintBootstrapGrantResult> {
  const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
    data: JSON.stringify({ rootLogId }),
    headers: { "content-type": "application/json" },
  });
  const problemMint = await reportProblemDetails(mintRes, testInfo);
  if (
    skipOrThrowIfBootstrapMintUnconfigured(
      mintRes.status(),
      problemMint,
      testInfo,
    ) === "skip"
  ) {
    return { skipped: true };
  }
  expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(201);
  const grantBase64 = (await mintRes.text()).trim();
  return { skipped: false, grantBase64 };
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

export interface CompleteBootstrapGrantWithReceiptResult {
  statusUrlAbsolute: string;
  receiptUrlAbsolute: string;
  entryIdHex: string;
  grantBase64: string;
  receiptRes: Awaited<ReturnType<typeof pollResolveReceiptUntil200>>;
}

/**
 * POST register-grant, poll until receipt redirect, GET receipt until 200.
 */
export async function completeBootstrapGrantWithReceipt(
  opts: CompleteBootstrapGrantWithReceiptOptions,
): Promise<CompleteBootstrapGrantWithReceiptResult> {
  const { statusUrlAbsolute } = await postRegisterGrantExpect303(
    opts.unauthorizedRequest,
    {
      logId: opts.logId,
      baseURL: opts.baseURL,
      grantBase64: opts.grantBase64,
    },
  );

  const ladder = opts.ladderMs ?? sequencingBackoff;
  const { receiptUrlAbsolute, entryIdHex } =
    await pollQueryRegistrationUntilReceiptRedirect({
      request: opts.unauthorizedRequest,
      statusUrlAbsolute,
      baseURL: opts.baseURL,
      ladderMs: ladder,
      maxWaitMs: opts.pollRegistrationMaxMs ?? 180_000,
    });

  const receiptRes = await pollResolveReceiptUntil200({
    request: opts.unauthorizedRequest,
    receiptUrlAbsolute,
    ladderMs: ladder,
    maxWaitMs: opts.resolveReceiptMaxMs ?? 420_000,
  });

  return {
    statusUrlAbsolute,
    receiptUrlAbsolute,
    entryIdHex,
    grantBase64: opts.grantBase64,
    receiptRes,
  };
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

/** True when sequencing poll tests should be skipped (no ingress). */
export function shouldSkipSequencingPoll(): boolean {
  return (
    process.env.E2E_SKIP_SEQUENCING_POLL === "1" ||
    process.env.E2E_SKIP_SEQUENCING_POLL === "true"
  );
}
