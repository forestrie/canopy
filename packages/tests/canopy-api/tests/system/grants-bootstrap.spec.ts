import { randomUUID } from "node:crypto";
import { decode } from "cbor-x";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { bytesEqual } from "@e2e-canopy-api-src/cbor-api/cbor-map-utils.js";
import {
  logIdToWireBytes,
  toPaddedWire32,
} from "@e2e-canopy-api-src/grant/log-id-wire.js";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  assertRootGrantTransparentStatement,
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
} from "@e2e-utils/bootstrap-grant-flow";
import { decodeEntryIdHex } from "@e2e-utils/entry-id-e2e";
import {
  assertBootstrapMintE2eEnv,
  e2eReceiptBootstrapRootLogId,
} from "@e2e-utils/e2e-env-guards";
import { describeForEachBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import type { E2eBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "@e2e-utils/problem-details";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  getForestGenesisParsed,
} from "@e2e-utils/univocity-genesis-e2e";
import { mintOnboardTokenE2e } from "@e2e-utils/onboard-token-e2e";

/**
 * Ephemeral Imutable chain-bound bootstrap: genesis POST, contract-bootstrap-signed
 * root creation grant, register-grant, sequencing → SCITT receipt.
 */
describeForEachBootstrapVariant(
  "Bootstrap grant e2e — mint and register-grant",
  (variant: E2eBootstrapVariant) => {
    test.describe.configure({ mode: "serial" });

    test("genesis is created with real chain binding and verifies via GET", async ({
      unauthorizedRequest,
    }) => {
      assertBootstrapMintE2eEnv();
      const onboardToken = await mintOnboardTokenE2e(unauthorizedRequest);
      const rootLogId = randomUUID();
      const boot = await variant.fetchBootstrapKey();

      await variant.ensureGenesis(
        unauthorizedRequest,
        rootLogId,
        onboardToken,
        boot.key,
      );

      const parsed = await getForestGenesisParsed(
        unauthorizedRequest,
        rootLogId,
      );
      expect(parsed.chainId).toBe(variant.chainId);
      expect(bytesEqual(parsed.univocityAddr, variant.contractAddrBytes)).toBe(
        true,
      );
      expect(parsed.bootstrapAlg).toBe(boot.alg);
      expect(bytesEqual(parsed.bootstrapKey!, boot.key)).toBe(true);
      expect(
        bytesEqual(
          parsed.bootstrapLogId,
          toPaddedWire32(logIdToWireBytes(rootLogId)),
        ),
      ).toBe(true);
    });

    test("Root grant mint yields valid transparent statement", async ({
      unauthorizedRequest,
    }) => {
      const logId = randomUUID();
      const { grantBase64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        logId,
        variant,
      );
      expect(() =>
        assertRootGrantTransparentStatement(grantBase64),
      ).not.toThrow();
    });

    test("After bootstrap mint, POST /register/{bootstrap}/grants returns 303 See Other (enqueued)", async ({
      unauthorizedRequest,
    }, testInfo) => {
      const logId = randomUUID();
      const baseURL = testInfo.project.use.baseURL ?? "";

      const { grantBase64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        logId,
        variant,
      );

      const registerRes = await unauthorizedRequest.post(
        `/register/${logId}/grants`,
        {
          headers: {
            Authorization: `Forestrie-Grant ${grantBase64}`,
          },
          maxRedirects: 0,
        },
      );

      const problemReg = await reportProblemDetails(registerRes, testInfo);
      const regStatus = registerRes.status();
      let regHint = formatProblemDetailsMessage(problemReg) ?? "register-grant";
      if (regStatus !== 303) {
        regHint += `\nBody preview: ${await responseTextPreview(registerRes)}`;
        regHint +=
          "\nExpected 303 See Other when bootstrap branch accepts the grant.";
      }
      expect(regStatus, regHint).toBe(303);

      const location = registerRes.headers().location;
      expect(location, "303 must include Location").toBeTruthy();
      let absolute = location!;
      if (!absolute.startsWith("http")) {
        absolute = `${baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
      }
      const escaped = logId.replace(/-/g, "\\-");
      expect(absolute).toMatch(
        new RegExp(`/logs/${escaped}/${escaped}/entries/[0-9a-f]{64}$`, "i"),
      );
    });

    test("Bootstrap mint + register, poll sequencing, SCITT receipt, mmrIndex 0", async ({
      unauthorizedRequest,
    }, testInfo) => {
      const logId = e2eReceiptBootstrapRootLogId();
      const baseURL = testInfo.project.use.baseURL ?? "";

      const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        logId,
        variant,
      );

      const { grantBase64, statusUrlAbsolute, entryIdHex, receiptRes } =
        await completeBootstrapGrantWithReceipt({
          unauthorizedRequest,
          logId,
          baseURL,
          grantBase64: mintGrantB64,
          variant,
          ladderMs: sequencingBackoff,
        });

      expect(receiptRes.status, "resolve-receipt returns CBOR receipt").toBe(
        200,
      );
      const ct = receiptRes.headers["content-type"] ?? "";
      expect(ct, "SCITT receipt content type").toMatch(
        /application\/scitt-receipt\+cbor/i,
      );

      const receiptBytes = receiptRes.body;
      const decoded = decode(receiptBytes) as unknown;
      expect(Array.isArray(decoded), "receipt is COSE Sign1 array").toBe(true);
      expect((decoded as unknown[]).length).toBe(4);

      const { mmrIndex } = decodeEntryIdHex(entryIdHex);
      expect(mmrIndex, "first leaf on fresh logId").toBe(0n);

      const completedB64 = buildCompletedGrantBase64(
        grantBase64,
        receiptBytes,
        entryIdHex,
      );

      const secondRegisterRes = await unauthorizedRequest.post(
        `/register/${logId}/grants`,
        {
          headers: { Authorization: `Forestrie-Grant ${completedB64}` },
          maxRedirects: 0,
        },
      );
      const problemSecond = await reportProblemDetails(
        secondRegisterRes,
        testInfo,
      );
      expect(
        secondRegisterRes.status(),
        formatProblemDetailsMessage(problemSecond) ??
          (await responseTextPreview(secondRegisterRes)),
      ).toBe(303);
      const locSecond = secondRegisterRes.headers().location;
      expect(
        locSecond,
        "second register-grant 303 must include Location",
      ).toBeTruthy();
      let absoluteSecond = locSecond!;
      if (!absoluteSecond.startsWith("http")) {
        absoluteSecond = `${baseURL}${absoluteSecond.startsWith("/") ? "" : "/"}${absoluteSecond}`;
      }
      const innerMatch = statusUrlAbsolute.match(/\/entries\/([0-9a-f]{64})/i);
      expect(innerMatch, "status URL must contain inner hex").toBeTruthy();
      const innerHex = innerMatch![1]!.toLowerCase();
      expect(absoluteSecond.toLowerCase()).toContain(`/entries/${innerHex}`);
    });

    test("register-grant on warm R confirms established root or returns 303 when cold", async ({
      unauthorizedRequest,
    }, testInfo) => {
      assertBootstrapMintE2eEnv();
      const onboardToken = await mintOnboardTokenE2e(unauthorizedRequest);
      const rootLogId = e2eReceiptBootstrapRootLogId();
      const baseURL = testInfo.project.use.baseURL ?? "";
      const boot = await variant.fetchBootstrapKey();

      await variant.ensureGenesis(
        unauthorizedRequest,
        rootLogId,
        onboardToken,
        boot.key,
      );

      const { grantBase64 } = variant.mintRootGrant(rootLogId, boot.key);

      const registerRes = await unauthorizedRequest.post(
        `/register/${rootLogId}/grants`,
        {
          headers: { Authorization: `Forestrie-Grant ${grantBase64}` },
          maxRedirects: 0,
        },
      );

      const problem = await reportProblemDetails(registerRes, testInfo);
      const status = registerRes.status();

      if (status === 303) {
        const location = registerRes.headers().location;
        expect(location, "303 must include Location").toBeTruthy();
        let absolute = location!;
        if (!absolute.startsWith("http")) {
          absolute = `${baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
        }
        const escaped = rootLogId.replace(/-/g, "\\-");
        expect(absolute).toMatch(
          new RegExp(`/logs/${escaped}/${escaped}/entries/[0-9a-f]{64}$`, "i"),
        );
        return;
      }

      const detail = problem?.detail ?? "";
      const bodyText = await responseTextPreview(registerRes);
      const hint = formatProblemDetailsMessage(problem) ?? bodyText;
      const warmReceiptRequired =
        /unprotected header 396|inclusion is required/i.test(detail) ||
        /unprotected header 396|inclusion is required/i.test(bodyText);
      expect(
        warmReceiptRequired,
        `register-grant returned ${status}, neither 303 nor warm receipt-required. ${hint}`,
      ).toBe(true);

      const parsed = await getForestGenesisParsed(
        unauthorizedRequest,
        rootLogId,
      );
      const expectedAlg =
        variant.id === "es256" ? COSE_ALG_ES256 : COSE_ALG_KS256;
      expect(parsed.bootstrapAlg, hint).toBe(expectedAlg);
      expect(bytesEqual(parsed.bootstrapKey!, boot.key)).toBe(true);
    });
  },
);
