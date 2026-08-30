/**
 * E2e (plan-2608-14 4.1, devdocs ADR-0065): a PASSKEY-rooted data log whose
 * per-turn leaves are signed by an endorsed SESSION key carrying the v2
 * endorsement at unprotected label -65801.
 *
 *   R (bootstrap root) → A (auth log, custody key) → U (data log,
 *   grantData = passkey x‖y, GF_REQUIRES_USER_VERIFICATION)
 *
 * The thinker topology (authority log → user log) rebuilt from public
 * artifacts on the deployed stack, with the passkey synthetic: the
 * construction is byte-for-byte what a real authenticator produces, so
 * nothing here takes a test-only branch in canopy, the coordinator, the
 * sealer or the offline rung.
 *
 * Test 1 (always): canopy SCRAPI admission — THE leaf-signer enforcement
 * point (ADR-0065 §1). Reproduces the plan-2608-13 5.2 live failure (a bare
 * session-signed leaf → `403 signer_mismatch`), then proves the §4 rules
 * fail-closed (wrong root, missing UV) and that the endorsed leaf is admitted.
 *
 * Test 2 (default-on; opt out with `E2E_PASSKEY_SEAL_STRETCH=0`): the leaf
 * seals under a WebAuthn two-gesture standing delegation and the receipt
 * verifies offline through `verifyEndorsedLeaf` (ADR-0065 §5) from the root,
 * the leaf bytes and the receipt alone. It was opt-in while the deployed
 * sealer verified delegation certificates as plain ES256 over `Sig_structure`
 * and refused the `-65800` envelope; arbor#95 (v0.1.35,
 * `delegationcert.VerifyCertificateSignature` envelope branch) closed that
 * gap and this test went green on lane A 2026-08-30, so it is now the
 * standing regression guard for it.
 */

import { randomUUID } from "node:crypto";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  establishStandingDelegation,
  mintBootstrapGrant,
  signChildGrantUnderRoot,
} from "@e2e-utils/bootstrap-grant-flow";
import { pollBootstrapRegistrationThroughReceipt } from "@e2e-utils/bootstrap-delegation-coordinator";
import { assertCoordinatorApiE2eEnv } from "@e2e-utils/coordinator-api-env";
import {
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers";
import {
  custodianCustodySignEnv,
  e2eCustodianKeyOwnerId,
  grantData64FromCustodianPem,
  postCustodianEnsureEs256Key,
  signGrantPayloadWithCustodyKey,
} from "@e2e-utils/custodian-custody-grant";
import {
  assertSystemE2eEnv,
  e2eReceiptBootstrapRootLogId,
} from "@e2e-utils/e2e-env-guards";
import {
  authLogBootstrapShapedFlags,
  dataLogCreateExtendFlags,
  withRequiresUserVerification,
} from "@e2e-utils/e2e-grant-flags";
import { describeForEachBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import type { E2eBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import {
  decodeEntryIdHex,
  entryIdHexToIdtimestampBe8,
} from "@e2e-utils/entry-id-e2e";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id";
import {
  assert303ContentHashLocation,
  postLogEntriesCoseSign1,
} from "@e2e-utils/post-entries-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "@e2e-utils/problem-details";
import { completeGrantRegistrationThroughReceipt } from "@e2e-utils/register-grant-through-receipt";
import { sha256Hex } from "@e2e-utils/statement-sign-bytes";
import {
  exchangeEs256ControlPlaneSession,
  postSigningRouteWithSession,
  WALLET_CHALLENGE_ES256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e";
import { extractDelegationCertFromReceipt } from "@e2e-utils/byok-wallet-seal-helpers";
import {
  passkeySessionCustody,
  signEndorsedSessionStatement,
  verifyEndorsedLeaf,
  type PasskeySessionCustody,
} from "@forestrie/canopy-e2e-kit";
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";

const sealStretchSkip =
  process.env.E2E_PASSKEY_SEAL_STRETCH?.trim() === "0"
    ? "Passkey seal stretch disabled by E2E_PASSKEY_SEAL_STRETCH=0 (admission " +
      "coverage runs regardless)."
    : null;

function e2eTurnPayload(userLogId: string, turn: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: "canopy-e2e-passkey-endorsed-turn",
      userLogId,
      turn,
      v: 1,
    }),
  );
}

async function absoluteUrl(baseURL: string, location: string): Promise<string> {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

describeForEachBootstrapVariant(
  "Passkey-rooted data log — endorsed session leaves (ADR-0065)",
  (variant: E2eBootstrapVariant) => {
    test.describe.configure({ mode: "serial" });

    const shared = {
      rootLogId: "",
      baseURL: "",
      userLogId: "",
      completedUserB64: "",
      custody: null as PasskeySessionCustody | null,
      /** Set by test 1 for test 2: the admitted endorsed leaf and its status URL. */
      endorsedLeaf: null as Uint8Array | null,
      endorsedStatusUrl: "",
    };

    test.beforeAll(async ({ unauthorizedRequest }, testInfo) => {
      assertSystemE2eEnv();
      const custody = custodianCustodySignEnv()!;
      const rootLogId = e2eReceiptBootstrapRootLogId();
      const authLogId = randomUUID();
      const userLogId = randomUUID();
      const baseURL = testInfo.project.use.baseURL ?? "";
      shared.rootLogId = rootLogId;
      shared.baseURL = baseURL;
      shared.userLogId = userLogId;

      // R: bootstrap root, sealed.
      const { grantBase64: mintGrantB64 } = await mintBootstrapGrant(
        unauthorizedRequest,
        rootLogId,
        variant,
      );
      const rootComplete = await completeBootstrapGrantWithReceipt({
        unauthorizedRequest,
        logId: rootLogId,
        baseURL,
        grantBase64: mintGrantB64,
        variant,
        ladderMs: sequencingBackoff,
      });
      expect(rootComplete.receiptRes.status).toBe(200);

      // A: the authority log (thinker's grant-authority analogue), custody key.
      const { keyId: authKeyId, publicKeyPem: authPubPem } =
        await postCustodianEnsureEs256Key({
          baseUrl: custody.baseUrl,
          appToken: custody.token,
          keyOwnerId: e2eCustodianKeyOwnerId(),
          selfLogId: authLogId,
        });
      const authSegment = authKeyId.split("/cryptoKeys/").pop() ?? authKeyId;
      const authGrant: Grant = {
        logId: uuidToBytes(authLogId),
        ownerLogId: uuidToBytes(rootLogId),
        grant: authLogBootstrapShapedFlags(),
        maxHeight: 0,
        minGrowth: 0,
        grantData: grantData64FromCustodianPem(authPubPem),
      };
      const authGrantB64 = signChildGrantUnderRoot(variant, authGrant);
      const authComplete = await completeGrantRegistrationThroughReceipt({
        unauthorizedRequest,
        bootstrapLogId: rootLogId,
        baseURL,
        grantBase64: authGrantB64,
        ladderMs: sequencingBackoff,
      });
      expect(authComplete.receiptRes.status).toBe(200);
      const completedAuthB64 = buildCompletedGrantBase64(
        authGrantB64,
        authComplete.receiptRes.body,
        authComplete.entryIdHex,
      );

      // U: the passkey-rooted user data log. grantData = passkey x‖y (the
      // on-chain logRootKey), UV required — the flag canopy reads at
      // admission as the endorsement's UV policy (ADR-0065 §4).
      const passkey = await passkeySessionCustody();
      shared.custody = passkey;
      const userGrant: Grant = {
        logId: uuidToBytes(userLogId),
        ownerLogId: uuidToBytes(authLogId),
        grant: withRequiresUserVerification(dataLogCreateExtendFlags()),
        maxHeight: 0,
        minGrowth: 0,
        grantData: passkey.rootPublicKeyXY,
      };
      const userGrantB64 = await signGrantPayloadWithCustodyKey({
        baseUrl: custody.baseUrl,
        appToken: custody.token,
        keyId: authSegment,
        grant: userGrant,
      });

      // Sealing authority for U is the passkey itself: coordinator public
      // root + signing route, and the standing delegation covered in advance
      // with the WebAuthn two-gesture material — BEFORE any leaf sequences on
      // U, so the sealer never has to raise a demand (FOR-531).
      if (!sealStretchSkip) {
        const coordinator = assertCoordinatorApiE2eEnv();
        const publicRoot = await uploadByokRootPublicKey({
          coordinatorUrl: coordinator.baseUrl,
          token: coordinator.appToken,
          logId: userLogId,
          x: passkey.rootPublicKeyXY.subarray(0, 32),
          y: passkey.rootPublicKeyXY.subarray(32, 64),
        });
        expect(publicRoot.status).toBe(200);
        const session = await exchangeEs256ControlPlaneSession({
          request: unauthorizedRequest,
          coordinatorUrl: coordinator.baseUrl,
          authLogId: userLogId,
          scopes: WALLET_CHALLENGE_ES256_SCOPES,
          rootKeyPair: passkey.rootKeyPair,
        });
        await postSigningRouteWithSession({
          request: unauthorizedRequest,
          coordinatorUrl: coordinator.baseUrl,
          logId: userLogId,
          sessionToken: session.token,
          mode: "wallet",
        });
        await establishStandingDelegation({
          request: unauthorizedRequest,
          logId: userLogId,
          signingContext: { variant, passkeyRootKeyPair: passkey.rootKeyPair },
        });
      }

      const userComplete = await completeGrantRegistrationThroughReceipt({
        unauthorizedRequest,
        bootstrapLogId: rootLogId,
        baseURL,
        grantBase64: userGrantB64,
        ladderMs: sequencingBackoff,
        parentGrantBase64: completedAuthB64,
      });
      expect(userComplete.receiptRes.status).toBe(200);
      shared.completedUserB64 = buildCompletedGrantBase64(
        userGrantB64,
        userComplete.receiptRes.body,
        userComplete.entryIdHex,
      );
    });

    test("admission: bare session leaf refused (5.2), wrong root / no UV refused, endorsed leaf admitted", async ({
      unauthorizedRequest,
    }, testInfo) => {
      const custody = shared.custody!;
      const post = (sign1Bytes: Uint8Array) =>
        postLogEntriesCoseSign1(unauthorizedRequest, {
          bootstrapLogId: shared.rootLogId,
          logId: shared.userLogId,
          completedGrantB64: shared.completedUserB64,
          sign1Bytes,
        });
      const expectRefused = async (
        sign1Bytes: Uint8Array,
        reason: string,
        label: string,
      ) => {
        const res = await post(sign1Bytes);
        const problem = await reportProblemDetails(res, testInfo);
        const hint =
          formatProblemDetailsMessage(problem) ??
          (await responseTextPreview(res));
        expect(res.status(), `${label}: ${hint}`).toBe(403);
        expect(problem?.reason, label).toBe(reason);
      };

      // The plan-2608-13 5.2 live failure, byte-for-byte: session-signed,
      // no endorsement → kid is the session x, not grantData's.
      await expectRefused(
        await signEndorsedSessionStatement({
          custody,
          payload: e2eTurnPayload(shared.userLogId, 0),
          endorsement: null,
        }),
        "signer_mismatch",
        "bare session leaf",
      );

      // A valid endorsement under a DIFFERENT passkey never falls back.
      const other = await passkeySessionCustody({
        rootKeyPair: undefined,
      });
      const foreign = await passkeySessionCustody({
        rootKeyPair: other.rootKeyPair,
      });
      await expectRefused(
        await signEndorsedSessionStatement({
          custody: { ...custody, endorsement: foreign.endorsement },
          payload: e2eTurnPayload(shared.userLogId, 0),
        }),
        "endorsement_root_mismatch",
        "wrong-root endorsement",
      );

      // The grant demands UV; an endorsement gesture without it is refused.
      const noUv = await passkeySessionCustody({
        rootKeyPair: custody.rootKeyPair,
        uv: false,
      });
      await expectRefused(
        await signEndorsedSessionStatement({
          custody: noUv,
          payload: e2eTurnPayload(shared.userLogId, 0),
        }),
        "endorsement_uv_required",
        "no-UV endorsement",
      );

      // The endorsed leaf: session-signed, -65801 carried → admitted.
      const leaf = await signEndorsedSessionStatement({
        custody,
        payload: e2eTurnPayload(shared.userLogId, 1),
      });
      const res = await post(leaf);
      const problem = await reportProblemDetails(res, testInfo);
      expect(
        res.status(),
        formatProblemDetailsMessage(problem) ??
          (await responseTextPreview(res)),
      ).toBe(303);
      assert303ContentHashLocation({
        bootstrapLogId: shared.rootLogId,
        logId: shared.userLogId,
        baseURL: shared.baseURL,
        location: res.headers().location,
        contentHashHexLower: await sha256Hex(leaf),
      });
      shared.endorsedLeaf = leaf;
      shared.endorsedStatusUrl = await absoluteUrl(
        shared.baseURL,
        res.headers().location!,
      );
    });

    test("seal: WebAuthn standing delegation → receipt → verifyEndorsedLeaf offline", async ({
      unauthorizedRequest,
    }) => {
      test.skip(!!sealStretchSkip, sealStretchSkip ?? "");
      const custody = shared.custody!;
      const leaf = shared.endorsedLeaf!;
      expect(leaf, "test 1 must have admitted the endorsed leaf").toBeTruthy();

      const sealed = await pollBootstrapRegistrationThroughReceipt({
        request: unauthorizedRequest,
        statusUrlAbsolute: shared.endorsedStatusUrl,
        baseURL: shared.baseURL,
        logId: shared.userLogId,
        signingContext: { variant, passkeyRootKeyPair: custody.rootKeyPair },
        signedMaterialKeys: new Set<string>(),
        ladderMs: sequencingBackoff,
      });
      expect(sealed.receiptRes.status).toBe(200);
      expect(decodeEntryIdHex(sealed.entryIdHex).mmrIndex).toBe(0n);

      // The seal rode the passkey's WebAuthn delegation: the receipt's cert
      // (label 1000) verifies through the ADR-0063 envelope under the passkey
      // with UV, and NOT as a plain ES256 signature.
      const cert = extractDelegationCertFromReceipt(sealed.receiptRes.body);
      expect(
        await verifyCoseSign1WithParsedKey(
          cert,
          {
            x: custody.rootPublicKeyXY.subarray(0, 32),
            y: custody.rootPublicKeyXY.subarray(32, 64),
            curve: "P-256",
          },
          { requireUserVerification: true },
        ),
      ).toBe(true);
      expect(
        await verifyByokDelegationCertificate({
          certificate: cert,
          rootPublicKey: custody.rootKeyPair.publicKey,
        }),
      ).toBe(false);

      // ADR-0065 §5: the single offline rung, from public artifacts only —
      // root x‖y (== logRootKey), the EXACT leaf bytes, the receipt and its
      // idtimestamp. The endorsement is read from inside the leaf.
      const verdict = await verifyEndorsedLeaf(
        {
          rootPublicKeyXY: custody.rootPublicKeyXY,
          statementCbor: leaf,
          receiptCbor: sealed.receiptRes.body,
          idtimestampBe8: entryIdHexToIdtimestampBe8(sealed.entryIdHex),
        },
        { requireUserVerification: true },
      );
      expect(
        verdict.ok,
        verdict.ok
          ? ""
          : `verifyEndorsedLeaf failed: stage=${verdict.stage} reason=${verdict.reason}`,
      ).toBe(true);
      if (verdict.ok) {
        expect(Array.from(verdict.sessionPublicKeyXY)).toEqual(
          Array.from(custody.sessionPublicKeyXY),
        );
        expect(verdict.leafIdtimestampMs).toBeGreaterThanOrEqual(
          custody.window.notBefore,
        );
        expect(verdict.leafIdtimestampMs).toBeLessThanOrEqual(
          custody.window.notAfter,
        );
      }
      // Sanity: the logIdHex the sealer/publisher key on.
      expect(normalizeForestrieHexId32(shared.userLogId)).toHaveLength(32);
    });
  },
);
