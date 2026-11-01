/**
 * uint64 delegation range e2e: a wallet-managed (BYOK) log delegated in
 * advance over `[0, 2^53 + 7]` is issued, sealed and verified offline.
 *
 * 2^53 + 7 is the smallest kind of value a JavaScript `number` cannot hold
 * exactly, so this run fails if any hop on the path rounds the range through
 * a double:
 *
 * - the delegation-coordinator JSON wire carries range bounds as canonical
 *   decimal strings and stores them as 8-byte big-endian BLOBs
 *   (delegation-coordinator `src/types/active-log.ts`);
 * - the arbor sealer selects the lease by coverage and embeds the certificate
 *   at receipt label 1000
 *   ([arbor sealer](https://github.com/forestrie/arbor/tree/main/services/sealer));
 * - `@forestrie/delegation-cose` and `@forestrie/receipt-verify` read the
 *   certificate's range labels 3/4 as uint64 bigints.
 *
 * Only the standing delegate key is signed (delegation-in-advance, the same
 * contract as `signStandingAdvanceDelegation`). No on-demand windowed pending
 * row is signed, so the only certificate the sealer can lease is the one
 * carrying the wide range; the receipt's certificate is also compared byte
 * for byte with the coordinator's current certificate.
 *
 * Opt-in like byok-checkpoint-seal.spec.ts: E2E_BYOK_SEAL_STRETCH=1.
 */

import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { buildCompletedGrantBase64 } from "@e2e-utils/bootstrap-grant-flow";
import { assertCoordinatorApiE2eEnv } from "@e2e-utils/coordinator-api-env";
import {
  exportEs256RootXy,
  generateEs256RootKeyPair,
  importEs256PemKeyPair,
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
} from "@e2e-utils/coordinator-delegation-helpers";
import { bootstrapEs256PrivateKeyPem } from "@e2e-utils/mint-es256-root-grant-e2e";
import {
  exchangeEs256ControlPlaneSession,
  postSigningRouteWithSession,
  WALLET_CHALLENGE_ES256_SCOPES,
} from "@e2e-utils/wallet-challenge-session-e2e";
import { entryIdHexToIdtimestampBe8 } from "@e2e-utils/entry-id-e2e";
import { normalizeForestrieHexId32 } from "@e2e-utils/forestrie-hex-id";
import {
  extractDelegationCertFromReceipt,
  mintByokBootstrapGrant,
  signByokStatement,
} from "@e2e-utils/byok-wallet-seal-helpers";
import { postLogEntriesCoseSign1 } from "@e2e-utils/post-entries-e2e";
import { postRegisterGrantExpect303 } from "@e2e-utils/bootstrap-grant-setup";
import { mintOnboardTokenE2e } from "@e2e-utils/onboard-token-e2e";
import { sleepMs } from "@e2e-utils/arithmetic-backoff-poll";
import {
  type BootstrapSigningContext,
  es256BootstrapContractAddrBytes,
  getBootstrapVariant,
  pollBootstrapRegistrationThroughReceipt,
  signStandingAdvanceDelegation,
  univocityGenesisChainId,
} from "@forestrie/canopy-e2e-kit";
import {
  decodeCoseSign1Parts,
  normalizeIntKeyedMap,
  readUint64Label,
} from "@forestrie/delegation-cose";
import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  decodeForestrieGrantCose,
  verifyGrantReceiptOfflineWithKeys,
  verifyReceiptOfflineWithKeys,
} from "@forestrie/receipt-verify";
import { modeCWebhookSealSkipReason } from "@e2e-utils/mode-c-e2e-env";

/** First integer above 2^53 that is odd, so a double cannot represent it. */
const WIDE_MMR_END = 2n ** 53n + 7n;
const WIDE_MMR_END_DECIMAL = "9007199254740999";

/** Delegation certificate payload labels for the MMR range (arbor wire). */
const PAYLOAD_MMR_START = 3;
const PAYLOAD_MMR_END = 4;

/** How long to wait for the coordinator to list the standing delegate key. */
const STANDING_ENTRY_BUDGET_MS = 60_000;

const skip = (() => {
  if (process.env.E2E_BYOK_SEAL_STRETCH?.trim() !== "1") {
    return (
      "uint64 delegation range e2e requires E2E_BYOK_SEAL_STRETCH=1 " +
      "(it drives the BYOK checkpoint seal path against a live sealer)."
    );
  }
  return modeCWebhookSealSkipReason();
})();

test.describe("BYOK uint64 delegation range", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!skip, skip ?? "");

  test("delegation over [0, 2^53+7] issues, seals and verifies", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const coordinator = assertCoordinatorApiE2eEnv();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const rootLogId = randomUUID();
    const rootLogHex32 = normalizeForestrieHexId32(rootLogId);
    // Genesis chain-anchors the bootstrap key to the contract's on-chain
    // bootstrapConfig(), so the root must be the pinned bootstrap key.
    const pinnedPem = bootstrapEs256PrivateKeyPem();
    const rootKeyPair = pinnedPem
      ? await importEs256PemKeyPair(pinnedPem)
      : await generateEs256RootKeyPair();
    const signingContext: BootstrapSigningContext = {
      variant: getBootstrapVariant("es256"),
      es256RootKeyPair: rootKeyPair,
    };

    const { x, y } = await exportEs256RootXy(rootKeyPair);
    const publicRoot = await uploadByokRootPublicKey({
      coordinatorUrl: coordinator.baseUrl,
      token: coordinator.appToken,
      logId: rootLogId,
      x,
      y,
    });
    expect(publicRoot.status).toBe(200);
    const session = await exchangeEs256ControlPlaneSession({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      authLogId: rootLogId,
      scopes: WALLET_CHALLENGE_ES256_SCOPES,
      rootKeyPair,
    });
    await postSigningRouteWithSession({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      logId: rootLogId,
      sessionToken: session.token,
      mode: "wallet",
    });

    // Issue: cover the standing sealer key over [0, 2^53+7] before anything
    // is registered, so the sealer never has to raise a windowed demand.
    const standingStart = Date.now();
    let lastReason = "not attempted";
    let signed = false;
    while (Date.now() - standingStart < STANDING_ENTRY_BUDGET_MS) {
      const outcome = await signStandingAdvanceDelegation({
        request: unauthorizedRequest,
        coordinatorUrl: coordinator.baseUrl,
        coordinatorToken: coordinator.appToken,
        logId: rootLogId,
        logIdHex32: rootLogHex32,
        signingContext,
        horizonMmrEnd: WIDE_MMR_END,
      });
      if (outcome.signed) {
        signed = true;
        break;
      }
      lastReason = outcome.reason;
      await sleepMs(1000);
    }
    expect(signed, `standing delegation not signed: ${lastReason}`).toBe(true);

    // The coordinator's JSON wire must carry the bounds as exact decimal
    // strings; a JSON number would already have lost the low bits here.
    const current = await unauthorizedRequest.get(
      `${coordinator.baseUrl}/api/logs/${rootLogId}/delegation`,
    );
    expect(current.status()).toBe(200);
    const currentBody = (await current.json()) as {
      certificate: string;
      mmrStart: unknown;
      mmrEnd: unknown;
    };
    expect(currentBody.mmrStart).toBe("0");
    expect(currentBody.mmrEnd).toBe(WIDE_MMR_END_DECIMAL);
    console.log(
      `coordinator GET delegation: mmrStart=${JSON.stringify(currentBody.mmrStart)} ` +
        `mmrEnd=${JSON.stringify(currentBody.mmrEnd)}`,
    );

    const activeRow = await findActiveRow({
      request: unauthorizedRequest,
      coordinatorUrl: coordinator.baseUrl,
      coordinatorToken: coordinator.appToken,
      logIdHex32: rootLogHex32,
    });
    expect(
      activeRow,
      "log missing from GET /api/delegations/active",
    ).toBeTruthy();
    expect(activeRow!.mmrStart).toBe("0");
    expect(activeRow!.mmrEnd).toBe(WIDE_MMR_END_DECIMAL);
    console.log(
      `coordinator GET active: mmrStart=${JSON.stringify(activeRow!.mmrStart)} ` +
        `mmrEnd=${JSON.stringify(activeRow!.mmrEnd)}`,
    );

    // Seal the bootstrap grant (mmrIndex 0).
    const onboardToken = await mintOnboardTokenE2e(unauthorizedRequest, {
      chainId: univocityGenesisChainId(),
      univocityAddr: es256BootstrapContractAddrBytes(),
    });
    const { grantBase64, grantData } = await mintByokBootstrapGrant({
      request: unauthorizedRequest,
      rootLogId,
      onboardToken,
      rootKeyPair,
    });
    const { statusUrlAbsolute } = await postRegisterGrantExpect303(
      unauthorizedRequest,
      { bootstrapLogId: rootLogId, baseURL, grantBase64 },
    );
    const grantComplete = await pollBootstrapRegistrationThroughReceipt({
      request: unauthorizedRequest,
      statusUrlAbsolute,
      baseURL,
      logId: rootLogId,
      signingContext,
      signedMaterialKeys: new Set<string>(),
    });
    expect(grantComplete.receiptRes.status).toBe(200);

    // Seal a statement entry registered against the completed grant.
    const completedGrantB64 = buildCompletedGrantBase64(
      grantBase64,
      grantComplete.receiptRes.body,
      grantComplete.entryIdHex,
    );
    const statementSign1 = await signByokStatement({
      rootKeyPair,
      grantData,
      payload: new TextEncoder().encode(`uint64 delegation range ${rootLogId}`),
    });
    const entryRes = await postLogEntriesCoseSign1(unauthorizedRequest, {
      bootstrapLogId: rootLogId,
      logId: rootLogId,
      completedGrantB64,
      sign1Bytes: statementSign1,
    });
    expect(entryRes.status()).toBe(303);
    const entryComplete = await pollBootstrapRegistrationThroughReceipt({
      request: unauthorizedRequest,
      statusUrlAbsolute: absoluteUrl(baseURL, entryRes.headers().location!),
      baseURL,
      logId: rootLogId,
      signingContext,
      signedMaterialKeys: new Set<string>(),
    });
    expect(entryComplete.receiptRes.status).toBe(200);

    // The sealed certificate is the wide one, and its range labels are the
    // exact uint64 values, encoded as 8-byte CBOR unsigned integers.
    const coordinatorCert = base64ToBytes(currentBody.certificate);
    for (const receipt of [grantComplete, entryComplete]) {
      const cert = extractDelegationCertFromReceipt(receipt.receiptRes.body);
      expect(bytesToHex(cert)).toBe(bytesToHex(coordinatorCert));
      const { mmrStart, mmrEnd, payloadHex } = decodeCertificateRange(cert);
      expect(mmrStart).toBe(0n);
      expect(mmrEnd).toBe(WIDE_MMR_END);
      // label 4, major type 0 with an 8-byte argument (0x1b), then BE value.
      expect(payloadHex).toContain("041b0020000000000007");
      console.log(
        `receipt entry ${receipt.entryIdHex} certificate range: ` +
          `mmrStart=${mmrStart}n mmrEnd=${mmrEnd}n`,
      );
      expect(
        await verifyByokDelegationCertificate({
          certificate: cert,
          rootPublicKey: rootKeyPair.publicKey,
        }),
      ).toBe(true);
    }

    // Full offline verify (layers A–C) with the runner-held root as the
    // known log-owner key; the delegated sealer key chains from label 1000.
    const { grant: grantForVerify } = decodeForestrieGrantCose(
      base64ToBytes(grantBase64),
    );
    const grantOffline = await verifyGrantReceiptOfflineWithKeys({
      trustKeys: [rootKeyPair.publicKey],
      receiptCbor: grantComplete.receiptRes.body,
      grant: grantForVerify,
      idtimestampBe8: entryIdHexToIdtimestampBe8(grantComplete.entryIdHex),
    });
    expect(
      grantOffline.ok,
      `grant offline verify failed: stage=${grantOffline.stage} reason=${grantOffline.reason ?? "unknown"}`,
    ).toBe(true);
    const entryOffline = await verifyReceiptOfflineWithKeys({
      trustKeys: [rootKeyPair.publicKey],
      receiptCbor: entryComplete.receiptRes.body,
      payload: statementSign1,
      idtimestampBe8: entryIdHexToIdtimestampBe8(entryComplete.entryIdHex),
    });
    expect(
      entryOffline.ok,
      `entry offline verify failed: stage=${entryOffline.stage} reason=${entryOffline.reason ?? "unknown"}`,
    ).toBe(true);
  });
});

/** One row of GET /api/delegations/active (delegation-coordinator `ActiveLog`). */
type ActiveRow = {
  logIdHex32: string;
  mmrStart: unknown;
  mmrEnd: unknown;
};

/**
 * Walk GET /api/delegations/active (the sealer's resync feed) until the row
 * for `logIdHex32` appears. The cursor is opaque and pages shard by shard; a
 * null cursor means the whole set was walked.
 */
async function findActiveRow(opts: {
  request: Parameters<typeof signStandingAdvanceDelegation>[0]["request"];
  coordinatorUrl: string;
  coordinatorToken: string;
  logIdHex32: string;
}): Promise<ActiveRow | undefined> {
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${opts.coordinatorUrl}/api/delegations/active`);
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await opts.request.get(url.toString(), {
      headers: { authorization: `Bearer ${opts.coordinatorToken}` },
    });
    if (!res.ok()) {
      throw new Error(
        `GET active: ${res.status()} ${(await res.text()).slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as {
      logs: ActiveRow[];
      cursor: string | null;
    };
    const row = body.logs.find((l) => l.logIdHex32 === opts.logIdHex32);
    if (row) return row;
    cursor = body.cursor;
    if (!cursor) return undefined;
  }
  return undefined;
}

/**
 * Decode a delegation certificate's MMR range labels as uint64 bigints, and
 * return the payload hex for an encoding-level check.
 */
function decodeCertificateRange(cert: Uint8Array): {
  mmrStart: bigint;
  mmrEnd: bigint;
  payloadHex: string;
} {
  const { payloadBytes } = decodeCoseSign1Parts(cert);
  const payload = normalizeIntKeyedMap(decodeCborDeterministic(payloadBytes));
  return {
    mmrStart: readUint64Label(payload, PAYLOAD_MMR_START, "mmrStart"),
    mmrEnd: readUint64Label(payload, PAYLOAD_MMR_END, "mmrEnd"),
    payloadHex: bytesToHex(payloadBytes),
  };
}

function absoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

/** Standard or URL-safe base64 to bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
