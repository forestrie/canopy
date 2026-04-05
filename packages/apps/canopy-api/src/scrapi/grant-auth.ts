/**
 * COSE Sign1 helpers for register-statement: extract statement `kid` and compare to
 * **`grantData`**-derived binding from the Forestrie-Grant payload (Plan 0005).
 *
 * Grant bytes come from **Authorization: Forestrie-Grant** only — no R2 fetch or
 * X-Grant-Location path (Plan 0008).
 */

import { decode as decodeCbor } from "cbor-x";
import { custodianStatementKidFromXyGrantData } from "../grant/custodian-statement-kid.js";
import { grantDataToBytes } from "../grant/grant-data.js";
import type { Grant } from "../grant/types.js";
import { statementSignerBindingBytes } from "../grant/statement-signer-binding.js";
import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { cborResponse } from "../cbor-api/cbor-response.js";

/** COSE header label for key id (kid). */
const COSE_KID = 4;

/**
 * Extract signer (kid) from COSE Sign1 bytes. Returns Uint8Array of kid if present, else null.
 */
export function getSignerFromCoseSign1(
  coseSign1Bytes: Uint8Array,
): Uint8Array | null {
  let arr: unknown[];
  try {
    arr = decodeCbor(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const protectedBstr = arr[0];
  if (!(protectedBstr instanceof Uint8Array)) return null;
  let protectedMap: Record<number, unknown> | Map<number, unknown>;
  try {
    protectedMap = decodeCbor(protectedBstr) as
      | Record<number, unknown>
      | Map<number, unknown>;
  } catch {
    return null;
  }
  const kid =
    protectedMap instanceof Map
      ? protectedMap.get(COSE_KID)
      : (protectedMap as Record<number, unknown>)[COSE_KID];
  // Binding requires raw bytes (bstr). String kid would be UTF-8 encoded and not match grantData-derived binding.
  if (kid instanceof Uint8Array) return kid;
  return null;
}

/**
 * Compare statement COSE `kid` with grant binding bytes (byte equality).
 */
export function signerMatchesGrant(
  statementSigner: Uint8Array | null,
  grantSigner: Uint8Array,
): boolean {
  if (!statementSigner || statementSigner.length !== grantSigner.length)
    return false;
  for (let i = 0; i < grantSigner.length; i++) {
    if (statementSigner[i] !== grantSigner[i]) return false;
  }
  return true;
}

/**
 * Register-statement: COSE `kid` must equal {@link statementSignerBindingBytes} **or**, for
 * 64-byte ES256 **x||y** `grantData`, the 16-byte Custodian profile kid (bootstrap KMS Sign1).
 */
export function signerMatchesStatementRegistrationGrant(
  statementSigner: Uint8Array | null,
  grant: Grant,
): boolean {
  const primaryBinding = statementSignerBindingBytes(grant);
  if (primaryBinding.length === 0) return false;
  if (signerMatchesGrant(statementSigner, primaryBinding)) return true;

  const gd = grantDataToBytes(grant.grantData);
  if (gd.length !== 64 || !statementSigner || statementSigner.length !== 16) {
    return false;
  }
  try {
    const custodianKid = custodianStatementKidFromXyGrantData(gd);
    return signerMatchesGrant(statementSigner, custodianKid);
  } catch {
    return false;
  }
}

/** Problem detail body for grant auth failures (Concise Problem Details, CBOR). */
function grantAuthProblem(
  status: 401 | 402 | 403,
  title: string,
  detail: string,
  reason?: string,
): Response {
  const body: Record<string, unknown> = {
    type: "about:blank",
    title,
    status,
    detail,
  };
  if (reason) body.reason = reason;
  return cborResponse(body, status, {
    "content-type": CBOR_CONTENT_TYPES.PROBLEM_CBOR,
  });
}

export const GrantAuthErrors = {
  signerMismatch: () =>
    grantAuthProblem(
      403,
      "Forbidden",
      "Statement signer does not match the grant's signer binding (grantData).",
      "signer_mismatch",
    ),
};
