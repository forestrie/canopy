import type { APIRequestContext } from "@playwright/test";
import { decode } from "cbor-x";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { attachReceiptAndIdtimestampToTransparentStatement } from "@e2e-canopy-api-src/scrapi/attach-scitt-transparent-statement-receipt.js";
import {
  assertBootstrapMintE2eEnv,
  assertBootstrapReceiptE2eEnv,
} from "./e2e-env-guards";
import { entryIdHexToIdtimestampBe8 } from "./entry-id-e2e";
import type { E2eBootstrapVariant } from "./e2e-bootstrap-variant.js";
import { mintRootGrantForVariant } from "./mint-root-grant-e2e.js";
import {
  pollBootstrapRegistrationThroughReceipt,
  setupBootstrapCoordinatorDelegation,
} from "./bootstrap-delegation-coordinator.js";
import type { ByokPollStats } from "./byok-wallet-seal-helpers.js";
import { postRegisterGrantExpect303 } from "./bootstrap-grant-setup";
import { sequencingBackoff } from "./arithmetic-backoff-poll";

/** Plan 0014 / `transparent-statement.ts`: full grant v0 CBOR in unprotected header. */
const HEADER_FORESTRIE_GRANT_V0 = -65538;

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

/** COSE protected header alg label. */
const COSE_HEADER_ALG = 1;
const COSE_ALG_ES256 = -7;
const COSE_ALG_KS256 = -65799;

function algFromProtectedHeader(protectedBytes: Uint8Array): number | undefined {
  try {
    const decoded = decode(protectedBytes) as unknown;
    const m = toHeaderMap(decoded);
    const alg = m.get(COSE_HEADER_ALG);
    return typeof alg === "number" ? alg : undefined;
  } catch {
    return undefined;
  }
}

/** Assert root grant COSE Sign1 has 32-byte digest payload and grant v0 embedded. */
export function assertRootGrantTransparentStatement(base64: string): void {
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
    throw new Error("Expected COSE payload to be 32-byte SHA-256 digest");
  }
  const sig = sign1[3];
  const protectedBytes =
    sign1[0] instanceof Uint8Array ? sign1[0] : new Uint8Array(0);
  const alg = algFromProtectedHeader(protectedBytes);
  const expectedSigLen = alg === COSE_ALG_KS256 ? 65 : 64;
  if (!(sig instanceof Uint8Array) || sig.length !== expectedSigLen) {
    throw new Error(
      `Expected COSE ${alg === COSE_ALG_KS256 ? "KS256" : "ES256"} signature ` +
        `to be ${expectedSigLen} bytes`,
    );
  }
  if (alg !== COSE_ALG_ES256 && alg !== COSE_ALG_KS256) {
    throw new Error(`Unexpected grant protected alg ${String(alg)}`);
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
 * Root bootstrap mint: ephemeral Imutable chain binding + contract-bootstrap-signed
 * root creation grant. Requires curator token and Univocity provision env.
 */
export async function mintBootstrapGrant(
  unauthorizedRequest: APIRequestContext,
  rootLogId: string,
  variant: E2eBootstrapVariant,
): Promise<{ grantBase64: string }> {
  assertBootstrapMintE2eEnv();
  const curator = process.env.CURATOR_ADMIN_TOKEN!.trim();
  const { grantBase64 } = await mintRootGrantForVariant(
    unauthorizedRequest,
    rootLogId,
    variant,
    curator,
  );
  return { grantBase64 };
}

/** Sign a child (or other) grant with the owner root key for this variant. */
export function signChildGrantUnderRoot(
  variant: E2eBootstrapVariant,
  grant: Grant,
): string {
  return variant.signOwnerGrant(grant);
}

export interface CompleteBootstrapGrantWithReceiptOptions {
  unauthorizedRequest: APIRequestContext;
  logId: string;
  baseURL: string;
  grantBase64: string;
  variant: E2eBootstrapVariant;
  ladderMs?: number[];
  pollRegistrationMaxMs?: number;
  resolveReceiptMaxMs?: number;
}

export interface CompleteBootstrapGrantWithReceiptResult {
  statusUrlAbsolute: string;
  receiptUrlAbsolute: string;
  entryIdHex: string;
  grantBase64: string;
  receiptRes: {
    status: number;
    headers: { [key: string]: string };
    body: Uint8Array;
  };
}

/**
 * POST register-grant, poll until receipt redirect (with coordinator delegation
 * material loop), GET receipt until 200.
 */
export async function completeBootstrapGrantWithReceipt(
  opts: CompleteBootstrapGrantWithReceiptOptions,
): Promise<CompleteBootstrapGrantWithReceiptResult> {
  assertBootstrapReceiptE2eEnv();
  const signingContext = await setupBootstrapCoordinatorDelegation({
    request: opts.unauthorizedRequest,
    logId: opts.logId,
    variant: opts.variant,
  });
  const signedMaterialKeys = new Set<string>();
  const stats: ByokPollStats = {
    pendingEntriesSeen: 0,
    materialSigned: 0,
  };

  const { statusUrlAbsolute } = await postRegisterGrantExpect303(
    opts.unauthorizedRequest,
    {
      bootstrapLogId: opts.logId,
      baseURL: opts.baseURL,
      grantBase64: opts.grantBase64,
    },
  );

  const ladder = opts.ladderMs ?? sequencingBackoff;
  const { receiptUrlAbsolute, entryIdHex, receiptRes } =
    await pollBootstrapRegistrationThroughReceipt({
      request: opts.unauthorizedRequest,
      statusUrlAbsolute,
      baseURL: opts.baseURL,
      logId: opts.logId,
      signingContext,
      signedMaterialKeys,
      stats,
      ladderMs: ladder,
      maxWaitMs: opts.pollRegistrationMaxMs,
      resolveReceiptMaxMs: opts.resolveReceiptMaxMs,
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
