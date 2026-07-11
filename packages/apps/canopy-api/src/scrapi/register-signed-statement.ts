/**
 * Statement registration — **`POST /register/{bootstrap-logid}/entries`**.
 *
 * Unlike {@link registerGrant}, this path never *opens* a log; it only appends **statements**
 * to an existing target log **`T = grant.logId`** using an already-supplied grant. That grant
 * is a **single, self-authenticating credential**: it carries its own SCITT receipt, so
 * {@link grantAuthorize} authorizes it by inclusion alone — no parent evidence is ever needed
 * here (contrast register-grant's creation paths). See
 * [grants.md §7 Register-signed-statement](https://github.com/forestrie/canopy/blob/main/docs/grants.md#7-register-signed-statement-verification-summary)
 * and the credential/evidence model in
 * [grants.md §10](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model).
 *
 * **Flow:** The client sends the signed statement (COSE Sign1 body) and
 * **`Authorization: Forestrie-Grant`** holding a **transparent statement** (embedded grant,
 * idtimestamp, receipt). The handler resolves and authorizes the grant via receipt inclusion
 * ({@link grantAuthorize}), checks that it **allows statement registration** on **`T`**, checks
 * **`kid`** against **`grantData`**, verifies the **statement** COSE Sign1 (ES256 for **64-byte
 * x‖y** `grantData`, KS256 for **20-byte address** `grantData`), enqueues on **`T`**'s shard,
 * and returns **303** to the entry status URL.
 *
 * **Note:** The grant itself is NOT verified against `grantData` because delegated grants are
 * signed by the authority key (of `ownerLogId`), not the key embedded in `grantData`. The grant's
 * authenticity is established via receipt inclusion in {@link grantAuthorize}.
 *
 * **`O` and `T`:** `ownerLogId` is **`O`**, `logId` is **`T`**. Receipts witness inclusion of this
 * **grant leaf** in the transparency log that **sequenced** the grant — **`O`**. Statements are
 * sequenced on **`T`** (this handler) while {@link registerGrant} enqueues grant leaves on **`O`**.
 * **GF_DATA_LOG** statement grants require **`O ≠ T`** (see in-body check). The **first** statement
 * on an empty **`T`** is allowed once auth succeeds; **`T`** need not already contain entries. See
 * [grants.md §2 logId vs ownerLogId](https://github.com/forestrie/canopy/blob/main/docs/grants.md#2-logid-vs-ownerlogid-authorized-vs-owning).
 */

import {
  QueueFullError,
  type SequencingQueueStub,
} from "@canopy/forestrie-ingress-types";
import { getQueueForLog } from "../sequeue/logshard.js";
import { getContentSize, parseCborBody } from "../cbor-api/cbor-request.js";
import { seeOtherResponse } from "../cbor-api/cbor-response.js";

import { verifyCoseSign1 } from "@forestrie/encoding";
import { grantDataToBytes } from "../grant/grant-data.js";
import type { ParsedKs256RootKey } from "../grant/parsed-ks256-root-key.js";
import { verifyKs256CoseSign1, COSE_ALG_KS256 } from "../grant/ks256-verify.js";
import {
  getSignerFromCoseSign1,
  GrantAuthErrors,
  signerMatchesStatementRegistrationGrant,
} from "./grant-auth";
import { importEs256PublicKeyFromGrantDataXy64 } from "./custodian-grant.js";
import { isDataLogStatementGrantFlags } from "../grant/grant-flags.js";
import {
  isStatementRegistrationGrant,
  statementSignerBindingBytes,
} from "../grant/statement-signer-binding.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  getGrantFromRequest,
  grantAuthorize,
  type AuthGrantAuthorizeEnv,
} from "./auth-grant.js";
import { isCanopyApiPoolTestMode } from "../env/runtime-mode.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { getMaxStatementSize } from "./transparency-configuration";
import { getParsedGenesis } from "../forest/genesis-cache.js";
import {
  rpcUrlsForEnvChainId,
  type SupportedChainsEnv,
} from "../env/supported-chains-for-env.js";

/**
 * Statement Registration Request
 */
export interface RegisterStatementRequest {
  /** The signed statement to register (COSE Sign1) */
  signedStatement: Uint8Array;
}

/**
 * Statement Registration Response
 */
export interface RegisterStatementResponse {
  /** Operation ID for tracking the registration */
  operationId: string;
  /** Status of the registration */
  status: "accepted" | "pending";
}

/**
 * Registers one signed statement; **`grant.logId`** is always the target log **`T`**.
 *
 * @see File-level comment for full flow, **`O` vs `T`**, and caveats.
 */
export async function registerSignedStatement(
  request: Request,
  sequencingQueue: DurableObjectNamespace,
  shardCountStr: string,
  enqueueExtras: Parameters<SequencingQueueStub["enqueue"]>[2] | undefined,
  resolveReceiptAuthority: ReceiptAuthorityResolver | undefined,
  nodeEnv: string | undefined,
  bootstrapLogIdSegment: string,
  r2Grants: R2Bucket,
  supportedChainsEnv: SupportedChainsEnv,
): Promise<Response> {
  try {
    const nenv = nodeEnv ?? "production";
    if (!sequencingQueue && !isCanopyApiPoolTestMode({ NODE_ENV: nenv })) {
      return ServerErrors.serviceUnavailable(
        "Statement registration requires sequencing and inclusion verification (SEQUENCING_QUEUE).",
      );
    }

    const grantResult = getGrantFromRequest(request);
    if (grantResult instanceof Response) return grantResult;

    const genesisLookup = await getParsedGenesis(bootstrapLogIdSegment, {
      R2_GRANTS: r2Grants,
    });
    if ("kind" in genesisLookup && genesisLookup.kind === "bad_segment") {
      return ClientErrors.badRequest("Invalid bootstrap log-id in path");
    }
    if ("kind" in genesisLookup && genesisLookup.kind === "not_found") {
      return ClientErrors.notFound(
        "Not Found",
        "Forest genesis not found; provision POST /api/forest/{log-id}/genesis first.",
      );
    }
    if ("kind" in genesisLookup && genesisLookup.kind === "corrupt") {
      return ServerErrors.internal("Stored genesis for this forest is invalid");
    }
    const bootstrapUrlUuid = bytesToUuid(genesisLookup.wire);
    const ks256ChainId = genesisLookup.chainBinding?.chainId;

    const authEnv: AuthGrantAuthorizeEnv = {
      enforceInclusion: Boolean(sequencingQueue),
      resolveReceiptAuthority,
      ks256ChainId,
    };

    const { grant } = grantResult;

    let statementTargetLogUuid: string;
    try {
      statementTargetLogUuid = bytesToUuid(grant.logId);
    } catch {
      return ClientErrors.badRequest("Invalid logId in grant");
    }

    // --- Grant authorization — receipt-based inclusion only (no bootstrap path) ---
    // Same primitive as register-grant's "initialized log" branch: proves the Forestrie-Grant is
    // already sequenced into a transparency log so the embedded receipt (unprotected header 396)
    // verifies. The receipt travels in the artifact; the server builds or fetches nothing.
    const authError = await grantAuthorize(grantResult, authEnv);
    if (authError) return authError;

    // --- Request and body validation ---
    // Enforce max statement size; accept application/cose (raw COSE Sign1) or application/cbor
    // (wrapper with signedStatement). Reject unsupported media type.
    const maxSize = getMaxStatementSize();
    const size = getContentSize(request);
    if (typeof size === "number" && size > maxSize) {
      return ClientErrors.payloadTooLarge(size, maxSize);
    }

    let statementData: Uint8Array;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("cose")) {
      const buffer = await request.arrayBuffer();
      statementData = new Uint8Array(buffer);
    } else if (contentType.includes("cbor")) {
      try {
        const body = await parseCborBody<RegisterStatementRequest>(request);
        statementData = body.signedStatement;
      } catch (error) {
        return ClientErrors.invalidStatement(
          `Failed to parse CBOR body: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    } else {
      return ClientErrors.unsupportedMediaType(contentType);
    }

    // --- Statement structure and signer binding ---
    // grantData (committed in the grant) is the issuer's attestation of who may sign entries;
    // the statement COSE `kid` must match it. See grants.md §4:
    //   https://github.com/forestrie/canopy/blob/main/docs/grants.md#4-signer-commitments-vs-actual-grant-envelope-signer
    if (!isStatementRegistrationGrant(grant)) {
      return ClientErrors.forbidden(
        "Grant must authorize statement registration (data-log flags + extend, or auth-log bootstrap with create|extend).",
      );
    }

    if (
      isDataLogStatementGrantFlags(grant.grant) &&
      logIdBytesEqual(grant.ownerLogId as Uint8Array, grant.logId as Uint8Array)
    ) {
      return ClientErrors.forbidden(
        "Data-log statement-registration grant must use a distinct ownerLogId (governing AUTH log); ownerLogId must not equal logId.",
      );
    }

    if (!validateCoseSign1Structure(statementData)) {
      return ClientErrors.invalidStatement("Invalid COSE Sign1 structure");
    }

    const statementSigner = getSignerFromCoseSign1(statementData);
    const grantSignerBinding = statementSignerBindingBytes(grant);
    if (grantSignerBinding.length === 0) {
      return ClientErrors.forbidden(
        "Grant grantData must carry the statement signer binding (non-empty).",
      );
    }
    if (!signerMatchesStatementRegistrationGrant(statementSigner, grant)) {
      logSignerMismatch(statementSigner, grantSignerBinding);
      return GrantAuthErrors.signerMismatch();
    }

    // Statement signature verification: ES256 (64-byte x‖y) or KS256 (20-byte address).
    const grantDataBytes = grantDataToBytes(grant.grantData);
    if (grantDataBytes.length === 64) {
      let statementVerifyKey: CryptoKey;
      try {
        statementVerifyKey =
          await importEs256PublicKeyFromGrantDataXy64(grantDataBytes);
      } catch {
        return ClientErrors.forbidden(
          "Grant grantData is not valid ES256 x||y for statement signature verification.",
        );
      }
      const statementSigOk = await verifyCoseSign1(
        statementData,
        statementVerifyKey,
        { logFailures: true, logPrefix: "register-statement-payload" },
      );
      if (!statementSigOk) {
        return ClientErrors.invalidStatement(
          "Statement COSE signature verification failed.",
        );
      }
    } else if (grantDataBytes.length === 20) {
      const ks256Root: ParsedKs256RootKey = {
        kind: "KS256",
        alg: COSE_ALG_KS256,
        address: grantDataBytes,
      };
      const ks256RpcUrls = ks256ChainId
        ? (rpcUrlsForEnvChainId(supportedChainsEnv, ks256ChainId) ?? undefined)
        : undefined;
      const statementSigOk = await verifyKs256CoseSign1(
        statementData,
        ks256Root,
        {
          rpcUrls: ks256RpcUrls,
          logFailures: true,
          logPrefix: "register-statement-ks256",
        },
      );
      if (!statementSigOk) {
        return ClientErrors.invalidStatement(
          "Statement COSE signature verification failed.",
        );
      }
    } else {
      return ClientErrors.forbidden(
        "Grant grantData must be 64 bytes (ES256 x||y) or 20 bytes (KS256 address) for statement signature verification.",
      );
    }

    if (!sequencingQueue) {
      return ServerErrors.serviceUnavailable(
        "Statement sequencing not configured (SEQUENCING_QUEUE required)",
      );
    }

    // --- Enqueue for sequencing ---
    // Shard by target T = grant.logId (contrast: register-grant shards by owner O). Content hash
    // identifies the statement until sequencing completes. Response is 303 See Other to the entry
    // status URL; client polls until sequenced.
    const contentHash = await calculateSHA256(
      statementData.buffer as ArrayBuffer,
    );
    const logIdBytes = uuidToBytes(statementTargetLogUuid);
    const queue = getQueueForLog(
      { sequencingQueue, shardCountStr },
      statementTargetLogUuid,
    );
    await queue.enqueue(logIdBytes, hexToBytes(contentHash), enqueueExtras);

    const requestUrl = new URL(request.url);
    const location = `${requestUrl.origin}/logs/${bootstrapUrlUuid}/${statementTargetLogUuid}/entries/${contentHash}`;

    console.log("Statement registration accepted", {
      logId: statementTargetLogUuid,
      contentHash,
    });
    return seeOtherResponse(location, 5);
  } catch (error) {
    // Queue backpressure: return 503 with Retry-After so clients can back off (DO best practice).
    if (error instanceof QueueFullError) {
      console.warn("Queue full, returning 503:", {
        pendingCount: error.pendingCount,
        maxPending: error.maxPending,
        retryAfter: error.retryAfterSeconds,
      });
      return ServerErrors.serviceUnavailableWithRetry(
        `Queue capacity exceeded (${error.pendingCount}/${error.maxPending} pending)`,
        error.retryAfterSeconds,
      );
    }

    console.error("Error registering statement:", error);
    return ServerErrors.internal(
      error instanceof Error ? error.message : "Failed to register statement",
    );
  }
}

function logIdBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Log signer mismatch (grant auth). */
function logSignerMismatch(
  statementSigner: Uint8Array | null,
  grantSigner: Uint8Array,
): void {
  console.warn("[grant-auth] signer_mismatch", {
    statementKidLen: statementSigner?.length ?? 0,
    grantSignerLen: grantSigner.length,
  });
}

/**
 * Basic validation of COSE Sign1 structure
 */
function validateCoseSign1Structure(data: Uint8Array): boolean {
  // COSE Sign1 is a CBOR array with 4 elements
  // This is a basic check - full validation would decode and verify

  if (data.length < 10) return false; // Too small to be valid

  // Check for CBOR array marker (0x84 = array of 4 elements)
  // or 0x98 followed by 0x04 for indefinite-length array
  const firstByte = data[0];
  if (firstByte !== 0x84 && firstByte !== 0x98) {
    return false;
  }

  return true;
}

/**
 * Calculate SHA256 hash of content
 */
async function calculateSHA256(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convert UUID string to 16-byte ArrayBuffer
 */
function uuidToBytes(uuid: string): ArrayBuffer {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

/**
 * Convert hex string to ArrayBuffer
 */
function hexToBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}
