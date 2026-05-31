/**
 * Grant auth primitives. Two distinct artifacts flow through these helpers, and they
 * have different security types — see the model in
 * [grants.md §10 Authorization and evidence model](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model):
 *
 *  - {@link getGrantFromRequest} reads `Authorization: Forestrie-Grant <base64>`. This is
 *    the **signed, self-credentialing** grant: its COSE signature proves the caller holds
 *    the issuing authority's private key. It is both the credential and (for register-grant)
 *    the resource being created.
 *  - {@link getParentGrantFromRequest} reads the optional **request body** carrying a
 *    parent authority log's completed creation grant. That artifact is **public and
 *    replayable** (its receipt is published); it is verification *context*, not a
 *    credential — see
 *    [grants.md §11 Evidence transport](https://github.com/forestrie/canopy/blob/main/docs/grants.md#11-evidence-transport-parent-grant-post-body).
 *
 * {@link grantAuthorize} authorizes purely from the SCITT receipt embedded in a grant
 * (MMR inclusion proof + checkpoint signature against the owner-log receipt authority)
 * when `enforceInclusion` is true. The HTTP worker sets `enforceInclusion` whenever
 * sequencing/inclusion is configured; it is false only in pool-test mode with incomplete
 * bindings. The caller supplies the transparent statement only (receipt from the artifact);
 * authorization makes **no** call to the SequencingQueue Durable Object and has no
 * dependency on ephemeral queue state.
 */

import type { ParsedVerifyKey } from "@canopy/encoding";
import { decode as decodeCbor } from "cbor-x";
import type { GrantResult } from "../grant/types.js";
import { decodeTransparentStatement } from "../grant/transparent-statement.js";
import { verifyReceiptInclusionFromParsed } from "../grant/receipt-verify.js";
import { logIdBytesToCustodianLowerHex } from "../grant/uuid-bytes.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { cborResponse } from "../cbor-api/cbor-response.js";
import { getContentSize } from "../cbor-api/cbor-request.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";

const FORESTRIE_GRANT_SCHEME = "Forestrie-Grant";

/**
 * Maximum size of the register-grant request body that carries parent evidence. A
 * completed grant plus its inclusion receipt (with the MMR proof path) is small; 16 KiB
 * leaves generous headroom for tall trees while bounding work for unauthenticated callers.
 */
const MAX_PARENT_GRANT_BODY_SIZE = 16 * 1024;

/** Key of the parent-grant field in the register-grant CBOR request body (see §11 above). */
const PARENT_GRANT_BODY_KEY = "parentGrant";

/** Read `parentGrant` from a decoded CBOR map (plain object or `Map`). */
function readParentGrantField(body: unknown): unknown {
  if (body instanceof Map) {
    return body.get(PARENT_GRANT_BODY_KEY);
  }
  if (
    body &&
    typeof body === "object" &&
    !(body instanceof Uint8Array) &&
    !ArrayBuffer.isView(body)
  ) {
    return (body as Record<string, unknown>)[PARENT_GRANT_BODY_KEY];
  }
  return undefined;
}

/** Raw transparent-statement bytes → GrantResult; Response (400) on decode failure. */
function decodeForestrieGrantBytes(bytes: Uint8Array): GrantResult | Response {
  try {
    return decodeTransparentStatement(bytes);
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : "Invalid transparent statement";
    return ClientErrors.badRequest(msg);
  }
}

/** base64 (std or url) → transparent statement → GrantResult; Response on failure. */
function decodeForestrieGrantToken(token: string): GrantResult | Response {
  let bytes: Uint8Array;
  try {
    const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return ClientErrors.badRequest("Grant value is not valid base64.");
  }
  return decodeForestrieGrantBytes(bytes);
}

function unauthorizedGrantRequired(): Response {
  return cborResponse(
    {
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail:
        "Grant required. Supply Authorization: Forestrie-Grant <base64> (transparent statement).",
      reason: "grant_required",
    },
    401,
    { "Content-Type": CBOR_CONTENT_TYPES.PROBLEM_CBOR },
  );
}

/** Env for receipt-based authorization (inclusion verification). */
export interface AuthGrantAuthorizeEnv {
  /**
   * When true, the grant must pass receipt-based inclusion verification.
   * Set by callers whenever sequencing/inclusion is configured; false only in
   * pool-test mode with incomplete bindings (auth skipped). This is a
   * configuration flag, not Durable Object queue state.
   */
  enforceInclusion: boolean;
  /**
   * Resolves receipt signature verify key candidates (trust root + delegation).
   * Required when `enforceInclusion` is true.
   */
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
}

/**
 * Read the signed grant from `Authorization: Forestrie-Grant <base64>`:
 * base64-decode → COSE-decode → GrantResult (grant from payload, idtimestamp from
 * unprotected header -65537, receipt from header 396). No fetch.
 *
 * This is the **credential** for the request — the COSE signature proves possession of the
 * issuing authority's key. See
 * [grants.md §10 Authorization and evidence model](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model)
 * and the wire format in
 * [grants.md §3 Wire format](https://github.com/forestrie/canopy/blob/main/docs/grants.md#3-wire-format-forestrie-grant-v0-and-transparent-statement).
 *
 * @returns GrantResult or a Response to return (401 missing/wrong scheme, 400/403 invalid).
 */
export function getGrantFromRequest(request: Request): GrantResult | Response {
  const auth = request.headers.get("Authorization");
  if (!auth || typeof auth !== "string") {
    return unauthorizedGrantRequired();
  }
  const trimmed = auth.trim();
  const prefix = `${FORESTRIE_GRANT_SCHEME} `;
  if (!trimmed.startsWith(prefix)) {
    return unauthorizedGrantRequired();
  }
  const token = trimmed.slice(prefix.length).trim();
  if (!token) {
    return unauthorizedGrantRequired();
  }
  return decodeForestrieGrantToken(token);
}

/**
 * Read the parent authority log's completed creation grant from the optional
 * **register-grant request body** — a CBOR map `{ parentGrant: <bstr> }` whose value is
 * the raw COSE Sign1 bytes of the parent's completed transparent statement. This is the
 * public verification *evidence* for a child-data grant under an intermediate authority
 * log; the wire format and rationale (public, immutable, registration-only — so carried
 * by copy rather than embedded into the signed child statement) are documented in
 * [grants.md §11 Evidence transport](https://github.com/forestrie/canopy/blob/main/docs/grants.md#11-evidence-transport-parent-grant-post-body).
 *
 * Only register-grant's intermediate child-data branch consumes the body, so reading the
 * stream here does not race any other consumer. The receipt the parent grant carries is
 * verified by the caller via {@link grantAuthorize}, proving the parent is sealed without
 * any SequencingQueue Durable Object read.
 *
 * @returns `null` when there is no body / no `parentGrant` field (parent evidence absent);
 * a {@link GrantResult} when present and decodable; otherwise a Response — 413 when the
 * body exceeds {@link MAX_PARENT_GRANT_BODY_SIZE}, or 400 when the body or the embedded
 * transparent statement cannot be decoded.
 */
export async function getParentGrantFromRequest(
  request: Request,
): Promise<GrantResult | Response | null> {
  const declared = getContentSize(request);
  if (declared !== undefined && declared > MAX_PARENT_GRANT_BODY_SIZE) {
    return ClientErrors.payloadTooLarge(declared, MAX_PARENT_GRANT_BODY_SIZE);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return ClientErrors.badRequest("Failed to read register-grant body.");
  }
  if (bytes.length === 0) return null; // no body: parent evidence absent
  if (bytes.length > MAX_PARENT_GRANT_BODY_SIZE) {
    return ClientErrors.payloadTooLarge(
      bytes.length,
      MAX_PARENT_GRANT_BODY_SIZE,
    );
  }

  let body: unknown;
  try {
    body = decodeCbor(bytes);
  } catch {
    return ClientErrors.badRequest(
      "register-grant body must be a CBOR map (e.g. { parentGrant: <bytes> }).",
    );
  }
  const parentGrant = readParentGrantField(body);
  if (parentGrant == null) return null; // body without parentGrant: evidence absent
  if (!(parentGrant instanceof Uint8Array) || parentGrant.length === 0) {
    return ClientErrors.badRequest(
      "register-grant body parentGrant must be non-empty transparent-statement bytes.",
    );
  }
  return decodeForestrieGrantBytes(parentGrant);
}

/**
 * Verify that a grant's embedded SCITT receipt is valid when `enforceInclusion` is true.
 * Uses `grantResult.grant` and `grantResult.receipt` only; no request, no fetch, and no
 * SequencingQueue Durable Object read. A receipt is self-authenticating: it binds this
 * exact grant commitment to a leaf sealed under a checkpoint signed by the owner-log
 * receipt authority. This is the single check a steady-state grant needs — see
 * [grants.md §7 Register-signed-statement](https://github.com/forestrie/canopy/blob/main/docs/grants.md#7-register-signed-statement-verification-summary)
 * and the receipt-backed row in
 * [grants.md §6 Register-grant creation paths](https://github.com/forestrie/canopy/blob/main/docs/grants.md#6-register-grant-creation-paths).
 *
 * @returns null if valid (or when `enforceInclusion` is false — pool-test mode without
 * bindings); otherwise a Response (403/503) to return.
 */
export async function grantAuthorize(
  grantResult: GrantResult,
  env: AuthGrantAuthorizeEnv,
): Promise<Response | null> {
  if (!env.enforceInclusion) return null;

  if (grantResult.receipt == null) {
    return ClientErrors.forbidden(
      "Grant artifact must be a SCITT transparent statement with receipt (unprotected header 396) when inclusion is required.",
    );
  }

  const { grant, idtimestamp, receipt } = grantResult;
  if (!idtimestamp || idtimestamp.length < 8) {
    return ClientErrors.forbidden(
      "Grant must be completed (idtimestamp required for receipt verification).",
    );
  }

  if (!env.resolveReceiptAuthority) {
    return ServerErrors.serviceUnavailable(
      "Receipt authority resolver is not configured.",
    );
  }

  if (!receipt.coseSign1Bytes?.length) {
    return ClientErrors.forbidden(
      "Grant receipt is missing raw COSE Sign1 bytes for verification.",
    );
  }

  let receiptVerifyKeys: ParsedVerifyKey[];
  try {
    const keys = await env.resolveReceiptAuthority(
      logIdBytesToCustodianLowerHex(grant.ownerLogId),
      receipt.coseSign1Bytes,
    );
    if (!keys?.length) {
      return ClientErrors.forbidden(
        "Grant receipt delegation chain could not be verified.",
      );
    }
    receiptVerifyKeys = keys;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b404\b/.test(msg)) {
      return ClientErrors.forbidden(
        "Cannot resolve receipt verification key for this log (trust root).",
      );
    }
    console.warn("resolveReceiptAuthority failed", e);
    return ServerErrors.serviceUnavailable(
      msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
    );
  }

  const valid = await verifyReceiptInclusionFromParsed(
    grant,
    idtimestamp,
    receipt.explicitPeak,
    receipt.proof,
    {
      receiptCoseBytes: receipt.coseSign1Bytes,
      receiptVerifyKeys,
    },
  );
  if (!valid) {
    return ClientErrors.forbidden(
      "Grant receipt verification failed (receipt signature or inclusion proof).",
    );
  }

  // Authorization is complete: the receipt's MMR inclusion proof binds this exact
  // grant commitment to a leaf sealed under a checkpoint signed by the owner-log
  // receipt authority. No SequencingQueue lookup — authorization must not depend on
  // ephemeral Durable Object queue state.
  return null;
}
