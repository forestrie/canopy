import { encode as encodeCbor } from "cbor-x";
import { signCoseSign1Statement } from "@canopy/encoding";
import { expectAPI as expect, test } from "./fixtures/auth";
import { sequencingBackoff } from "./utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
} from "./utils/bootstrap-grant-flow";
import { custodianCustodySignEnv } from "./utils/custodian-custody-grant";
import { postCustodianSignRawPayloadBytes } from "./utils/custodian-sign-payload";
import {
  e2eReceiptBootstrapRootLogId,
  shouldSkipSequencingPoll,
  skipSequencingPollIfDisabled,
} from "./utils/e2e-env-guards";
import {
  assert303ContentHashLocation,
  postLogEntriesCoseSign1,
} from "./utils/post-entries-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";
import { sha256Hex } from "./utils/statement-sign-bytes";

function e2eFirstStatementPayload(): Uint8Array {
  const encoded = encodeCbor({
    kind: "canopy-e2e-first-statement",
    v: 1,
  });
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  return new Uint8Array(u8);
}

/**
 * First transparency **statement** on a freshly bootstrapped root log: completed
 * Forestrie-Grant (receipt + idtimestamp) plus COSE Sign1 from the **same** per-root
 * custody key used to mint the bootstrap grant.
 *
 * Needs the same sequencing + MMRS setup as `grants-bootstrap` poll test. The happy path
 * needs **Custodian** on the runner (`CUSTODIAN_URL`, `CUSTODIAN_APP_TOKEN`).
 * The wrong-signer test uses an ephemeral P-256 key locally (no Custodian sign call).
 *
 * One mint + completed grant is shared across both tests; `logId` is a fresh UUID
 * for the whole describe (via `e2eReceiptBootstrapRootLogId()` once in `beforeAll`).
 */
test.describe("Bootstrap log e2e — first signed entry", () => {
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  const shared = {
    logId: "",
    baseURL: "",
    completedGrantB64: "",
    rootCustodySignKeyId: "",
  };

  test.beforeAll(async ({ unauthorizedRequest }, testInfo) => {
    if (shouldSkipSequencingPoll()) {
      testInfo.skip(
        true,
        "E2E_SKIP_SEQUENCING_POLL: skip until SCITT / ingress",
      );
      return;
    }
    const logId = e2eReceiptBootstrapRootLogId();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const { grantBase64: mintGrantB64, rootCustodySignKeyId } =
      await mintBootstrapGrant(unauthorizedRequest, logId);

    const { grantBase64, entryIdHex, receiptRes } =
      await completeBootstrapGrantWithReceipt({
        unauthorizedRequest,
        logId,
        baseURL,
        grantBase64: mintGrantB64,
        ladderMs: sequencingBackoff,
      });

    expect(receiptRes.status).toBe(200);

    shared.logId = logId;
    shared.baseURL = baseURL;
    shared.rootCustodySignKeyId = rootCustodySignKeyId;
    shared.completedGrantB64 = buildCompletedGrantBase64(
      grantBase64,
      receiptRes.body,
      entryIdHex,
    );
  });

  test("POST /register/entries returns 303 with content-hash Location", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (skipSequencingPollIfDisabled(testInfo)) return;
    if (!shared.logId) return;

    const custody = custodianCustodySignEnv()!;
    const statementPayload = e2eFirstStatementPayload();
    const sign1Bytes = await postCustodianSignRawPayloadBytes({
      baseUrl: custody.baseUrl,
      bearerToken: custody.token,
      keyIdSegment: shared.rootCustodySignKeyId,
      payloadBytes: statementPayload,
    });

    const expectedHash = await sha256Hex(sign1Bytes);
    const entriesRes = await postLogEntriesCoseSign1(unauthorizedRequest, {
      bootstrapLogId: shared.logId,
      logId: shared.logId,
      completedGrantB64: shared.completedGrantB64,
      sign1Bytes,
    });

    const problem = await reportProblemDetails(entriesRes, testInfo);
    const hint =
      formatProblemDetailsMessage(problem) ??
      (await responseTextPreview(entriesRes));
    expect(entriesRes.status(), hint).toBe(303);

    assert303ContentHashLocation({
      bootstrapLogId: shared.logId,
      logId: shared.logId,
      baseURL: shared.baseURL,
      location: entriesRes.headers().location,
      contentHashHexLower: expectedHash,
    });
  });

  test("POST /register/entries rejects valid Sign1 when kid is not bootstrap signer", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (skipSequencingPollIfDisabled(testInfo)) return;
    if (!shared.logId) return;

    // Ephemeral P-256 key: kid = 32-byte x from uncompressed raw public key (04||x||y).
    // Bootstrap grantData binds the root custody pubkey, so this must not match.
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rawSpki = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    expect(rawSpki[0]).toBe(0x04);
    const wrongKid = rawSpki.subarray(1, 33);

    const sign1Bytes = await signCoseSign1Statement(
      e2eFirstStatementPayload(),
      wrongKid,
      pair.privateKey,
    );

    const entriesRes = await postLogEntriesCoseSign1(unauthorizedRequest, {
      bootstrapLogId: shared.logId,
      logId: shared.logId,
      completedGrantB64: shared.completedGrantB64,
      sign1Bytes,
    });

    const problem = await reportProblemDetails(entriesRes, testInfo);
    const hint =
      formatProblemDetailsMessage(problem) ??
      (await responseTextPreview(entriesRes));
    expect(entriesRes.status(), hint).toBe(403);
    expect(problem?.reason).toBe("signer_mismatch");
    expect(problem?.detail).toContain("signer binding");
  });
});
