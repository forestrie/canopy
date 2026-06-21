/**
 * Registration control plane e2e: onboard-token mint, genesis registration,
 * and GF_DERIVED endorsement descendant flow.
 */

import { randomUUID } from "node:crypto";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import type { Grant } from "@e2e-canopy-api-src/grant/types.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "@e2e-canopy-api-src/forest/forest-genesis-labels.js";
import { COSE_ALG_ES256 } from "@e2e-canopy-api-src/cose/cose-key.js";
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import { sequencingBackoff } from "@e2e-utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrant,
  signChildGrantUnderRoot,
} from "@e2e-utils/bootstrap-grant-flow";
import {
  assertBootstrapMintE2eEnv,
  assertBootstrapReceiptE2eEnv,
} from "@e2e-utils/e2e-env-guards";
import { getBootstrapVariant } from "@e2e-utils/e2e-bootstrap-variant";
import {
  authLogBootstrapShapedFlags,
  derivedEndorsementGrantFlags,
} from "@e2e-utils/e2e-grant-flags";
import {
  assertOpsAdminE2eEnv,
  mintOnboardTokenE2e,
} from "@e2e-utils/onboard-token-e2e";
import { completeGrantRegistrationThroughReceipt } from "@e2e-utils/register-grant-through-receipt";
import { univocityProvisionSkipReason } from "@e2e-utils/univocity-genesis-e2e";

function genesisBodyEs256(
  bootstrapKey: Uint8Array,
  univocityAddr: Uint8Array,
  chainId: string,
): Uint8Array {
  return encodeCbor(
    new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
      [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, bootstrapKey],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, univocityAddr],
      [FOREST_GENESIS_LABEL_CHAIN_ID, chainId],
    ]),
  ) as Uint8Array;
}

function forestrieGrantAuthHeader(completedGrantB64: string): string {
  return `Forestrie-Grant ${completedGrantB64}`;
}

test.describe("Forest genesis registration control plane", () => {
  test.describe.configure({ mode: "serial" });

  test("ops mints onboard token and genesis registers payment-authoritative forest", async ({
    unauthorizedRequest,
  }) => {
    assertOpsAdminE2eEnv();
    assertBootstrapMintE2eEnv();
    const skip = univocityProvisionSkipReason();
    test.skip(!!skip, skip ?? "");

    const ops = process.env.CANOPY_OPS_ADMIN_TOKEN!.trim();
    const listRes = await unauthorizedRequest.get(
      "/api/payments/onboard-tokens",
      { headers: { Authorization: `Bearer ${ops}` } },
    );
    expect(listRes.status()).toBe(200);

    const onboardToken = await mintOnboardTokenE2e(
      unauthorizedRequest,
      "forest-genesis-registration",
    );
    const logId = randomUUID();
    const variant = getBootstrapVariant("es256");
    const boot = await variant.fetchBootstrapKey();

    const postRes = await unauthorizedRequest.post(
      `/api/forest/${logId}/genesis`,
      {
        headers: {
          Authorization: `Bearer ${onboardToken}`,
          "Content-Type": "application/cbor",
        },
        data: Buffer.from(
          genesisBodyEs256(
            boot.key,
            variant.contractAddrBytes,
            variant.chainId,
          ),
        ),
      },
    );
    expect(postRes.status()).toBe(201);
    const body = decodeCbor(new Uint8Array(await postRes.body())) as {
      R?: string;
      class?: string;
      chainBinding?: { chainId?: string };
    };
    expect(body.R).toBe(logId);
    expect(body.class).toBe("payment-authoritative");
    expect(body.chainBinding?.chainId).toBe(variant.chainId);

    const getRes = await unauthorizedRequest.get(
      `/api/forest/${logId}/genesis`,
    );
    expect(getRes.status()).toBe(200);
  });

  test("rejects genesis without auth", async ({ unauthorizedRequest }) => {
    const logId = randomUUID();
    const res = await unauthorizedRequest.post(`/api/forest/${logId}/genesis`, {
      headers: { "Content-Type": "application/cbor" },
      data: Buffer.from(
        genesisBodyEs256(
          new Uint8Array(64).fill(1),
          new Uint8Array(20).fill(2),
          "84532",
        ),
      ),
    });
    expect(res.status()).toBe(401);
  });

  test("rejects revoked onboard token at genesis", async ({
    unauthorizedRequest,
  }) => {
    assertOpsAdminE2eEnv();
    const ops = process.env.CANOPY_OPS_ADMIN_TOKEN!.trim();
    const mintRes = await unauthorizedRequest.post(
      "/api/payments/onboard-tokens",
      {
        headers: {
          Authorization: `Bearer ${ops}`,
          "Content-Type": "application/cbor",
        },
        data: Buffer.from(encodeCbor(new Map()) as Uint8Array),
      },
    );
    expect(mintRes.status()).toBe(201);
    const minted = decodeCbor(new Uint8Array(await mintRes.body())) as {
      token?: string;
      ref?: string;
    };
    const delRes = await unauthorizedRequest.delete(
      `/api/payments/onboard-tokens/${minted.ref}`,
      { headers: { Authorization: `Bearer ${ops}` } },
    );
    expect(delRes.status()).toBe(200);

    const logId = randomUUID();
    const res = await unauthorizedRequest.post(`/api/forest/${logId}/genesis`, {
      headers: {
        Authorization: `Bearer ${minted.token}`,
        "Content-Type": "application/cbor",
      },
      data: Buffer.from(
        genesisBodyEs256(
          new Uint8Array(64).fill(1),
          new Uint8Array(20).fill(2),
          "84532",
        ),
      ),
    });
    expect(res.status()).toBe(401);
  });

  test("GF_DERIVED endorsement grant registers regular forest under PA ancestor", async ({
    unauthorizedRequest,
  }, testInfo) => {
    assertBootstrapReceiptE2eEnv();
    const variant = getBootstrapVariant("es256");
    const skip = await variant.skipReason();
    test.skip(!!skip, skip ?? "");

    const paRoot = randomUUID();
    const childRoot = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const boot = await variant.fetchBootstrapKey();

    const { grantBase64: rootGrantB64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      paRoot,
      variant,
    );
    const rootComplete = await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: paRoot,
      baseURL,
      grantBase64: rootGrantB64,
      variant,
      ladderMs: sequencingBackoff,
    });
    expect(rootComplete.receiptRes.status).toBe(200);

    const endorsementGrant: Grant = {
      logId: uuidToBytes(childRoot),
      ownerLogId: uuidToBytes(paRoot),
      grant: derivedEndorsementGrantFlags(),
      grantData: new Uint8Array(0),
    };
    const endorsementB64 = signChildGrantUnderRoot(variant, endorsementGrant);
    const endorsed = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      bootstrapLogId: paRoot,
      baseURL,
      grantBase64: endorsementB64,
      ladderMs: sequencingBackoff,
    });
    expect(endorsed.receiptRes.status).toBe(200);

    const completedEndorsementB64 = buildCompletedGrantBase64(
      endorsementB64,
      endorsed.receiptRes.body,
      endorsed.entryIdHex,
    );

    const genesisRes = await unauthorizedRequest.post(
      `/api/forest/${childRoot}/genesis`,
      {
        headers: {
          Authorization: forestrieGrantAuthHeader(completedEndorsementB64),
          "Content-Type": "application/cbor",
        },
        data: Buffer.from(
          genesisBodyEs256(
            boot.key,
            variant.contractAddrBytes,
            variant.chainId,
          ),
        ),
      },
    );
    expect(genesisRes.status()).toBe(201);
    const regBody = decodeCbor(new Uint8Array(await genesisRes.body())) as {
      R?: string;
      class?: string;
      endorsedBy?: string;
    };
    expect(regBody.R).toBe(childRoot);
    expect(regBody.class).toBe("regular");
    expect(regBody.endorsedBy).toBe(paRoot);
  });

  test("rejects genesis when endorsement grant lacks GF_DERIVED", async ({
    unauthorizedRequest,
  }, testInfo) => {
    assertBootstrapReceiptE2eEnv();
    const variant = getBootstrapVariant("es256");
    const skip = await variant.skipReason();
    test.skip(!!skip, skip ?? "");

    const paRoot = randomUUID();
    const childRoot = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const boot = await variant.fetchBootstrapKey();

    const { grantBase64: rootGrantB64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      paRoot,
      variant,
    );
    await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: paRoot,
      baseURL,
      grantBase64: rootGrantB64,
      variant,
      ladderMs: sequencingBackoff,
    });

    const badGrant: Grant = {
      logId: uuidToBytes(childRoot),
      ownerLogId: uuidToBytes(paRoot),
      grant: authLogBootstrapShapedFlags(),
      grantData: new Uint8Array(0),
    };
    const badB64 = signChildGrantUnderRoot(variant, badGrant);
    const registered = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      bootstrapLogId: paRoot,
      baseURL,
      grantBase64: badB64,
      ladderMs: sequencingBackoff,
    });
    const completedBadB64 = buildCompletedGrantBase64(
      badB64,
      registered.receiptRes.body,
      registered.entryIdHex,
    );

    const res = await unauthorizedRequest.post(
      `/api/forest/${childRoot}/genesis`,
      {
        headers: {
          Authorization: forestrieGrantAuthHeader(completedBadB64),
          "Content-Type": "application/cbor",
        },
        data: Buffer.from(
          genesisBodyEs256(
            boot.key,
            variant.contractAddrBytes,
            variant.chainId,
          ),
        ),
      },
    );
    expect(res.status()).toBe(403);
  });

  test("rejects genesis when endorsement grant logId does not match path", async ({
    unauthorizedRequest,
  }, testInfo) => {
    assertBootstrapReceiptE2eEnv();
    const variant = getBootstrapVariant("es256");
    const skip = await variant.skipReason();
    test.skip(!!skip, skip ?? "");

    const paRoot = randomUUID();
    const endorsedRoot = randomUUID();
    const pathRoot = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";
    const boot = await variant.fetchBootstrapKey();

    const { grantBase64: rootGrantB64 } = await mintBootstrapGrant(
      unauthorizedRequest,
      paRoot,
      variant,
    );
    await completeBootstrapGrantWithReceipt({
      unauthorizedRequest,
      logId: paRoot,
      baseURL,
      grantBase64: rootGrantB64,
      variant,
      ladderMs: sequencingBackoff,
    });

    const mismatchGrant: Grant = {
      logId: uuidToBytes(endorsedRoot),
      ownerLogId: uuidToBytes(paRoot),
      grant: derivedEndorsementGrantFlags(),
      grantData: new Uint8Array(0),
    };
    const mismatchB64 = signChildGrantUnderRoot(variant, mismatchGrant);
    const registered = await completeGrantRegistrationThroughReceipt({
      unauthorizedRequest,
      bootstrapLogId: paRoot,
      baseURL,
      grantBase64: mismatchB64,
      ladderMs: sequencingBackoff,
    });
    const completedMismatchB64 = buildCompletedGrantBase64(
      mismatchB64,
      registered.receiptRes.body,
      registered.entryIdHex,
    );

    const res = await unauthorizedRequest.post(
      `/api/forest/${pathRoot}/genesis`,
      {
        headers: {
          Authorization: forestrieGrantAuthHeader(completedMismatchB64),
          "Content-Type": "application/cbor",
        },
        data: Buffer.from(
          genesisBodyEs256(
            boot.key,
            variant.contractAddrBytes,
            variant.chainId,
          ),
        ),
      },
    );
    expect(res.status()).toBe(403);
  });
});
