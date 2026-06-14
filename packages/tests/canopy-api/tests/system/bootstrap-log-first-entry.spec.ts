import { encode as encodeCbor } from "cbor-x";
import { signCoseSign1Statement } from "@canopy/encoding";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
} from "@e2e-utils/bootstrap-grant-flow";
import { e2eReceiptBootstrapRootLogId } from "@e2e-utils/e2e-env-guards";
import { describeForEachBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import type { E2eBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import {
  assert303ContentHashLocation,
  postLogEntriesCoseSign1,
} from "@e2e-utils/post-entries-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "@e2e-utils/problem-details";
import { sha256Hex } from "@e2e-utils/statement-sign-bytes";

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

describeForEachBootstrapVariant(
  "Bootstrap log e2e — first signed entry",
  (variant: E2eBootstrapVariant) => {
    test.describe.configure({ mode: "serial" });

    const shared = {
      logId: "",
      baseURL: "",
      completedGrantB64: "",
    };

    test.beforeAll(async ({ unauthorizedRequest }, testInfo) => {
      test.skip(
        !variant.supportsRootStatementRegistration,
        "register-statement requires ES256 grantData (64-byte x‖y)",
      );

      const logId = e2eReceiptBootstrapRootLogId();
      const baseURL = testInfo.project.use.baseURL ?? "";

      const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        logId,
        variant,
      );

      const { grantBase64, entryIdHex, receiptRes } =
        await completeBootstrapGrantWithReceipt({
          unauthorizedRequest,
          logId,
          baseURL,
          grantBase64: mintGrantB64,
          variant,
          ladderMs: sequencingBackoff,
        });

      expect(receiptRes.status).toBe(200);

      shared.logId = logId;
      shared.baseURL = baseURL;
      shared.completedGrantB64 = buildCompletedGrantBase64(
        grantBase64,
        receiptRes.body,
        entryIdHex,
      );
    });

    test("POST /register/entries returns 303 with content-hash Location", async ({
      unauthorizedRequest,
    }, testInfo) => {
      test.skip(
        !variant.supportsRootStatementRegistration,
        "register-statement requires ES256 grantData",
      );
      expect(
        shared.logId,
        "beforeAll must complete bootstrap + receipt",
      ).toBeTruthy();

      const statementPayload = e2eFirstStatementPayload();
      const sign1Bytes = await variant.signRootStatement(statementPayload);
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
      test.skip(
        !variant.supportsRootStatementRegistration,
        "register-statement requires ES256 grantData",
      );
      expect(
        shared.logId,
        "beforeAll must complete bootstrap + receipt",
      ).toBeTruthy();

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
  },
);
