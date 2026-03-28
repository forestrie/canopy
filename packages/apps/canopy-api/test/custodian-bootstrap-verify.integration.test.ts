/**
 * Optional integration: proves GET :bootstrap/public matches POST :bootstrap/sign (ES256).
 * Enable by setting CUSTODIAN_URL + CUSTODIAN_BOOTSTRAP_APP_TOKEN in
 * packages/apps/canopy-api/.dev.vars, or CUSTODIAN_INTEGRATION_URL /
 * CUSTODIAN_INTEGRATION_BOOTSTRAP_TOKEN in the environment. Skips when unset (CI).
 */

import { env as cloudflareTestEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeGrantPayload } from "../src/grant/codec.js";
import type { Grant } from "../src/grant/grant.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianPublicKey,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
  verifyCustodianEs256GrantSign1,
} from "../src/scrapi/custodian-grant.js";

function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error("invalid key length");
}

function integrationEnv(): { url: string; token: string } | null {
  const cf = cloudflareTestEnv as {
    CUSTODIAN_URL?: string;
    CUSTODIAN_BOOTSTRAP_APP_TOKEN?: string;
  };
  const url =
    process.env.CUSTODIAN_INTEGRATION_URL?.trim() ||
    cf.CUSTODIAN_URL?.trim() ||
    process.env.CUSTODIAN_URL?.trim();
  const token =
    process.env.CUSTODIAN_INTEGRATION_BOOTSTRAP_TOKEN?.trim() ||
    cf.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim() ||
    process.env.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

const integration = integrationEnv();

describe.skipIf(!integration)(
  "Custodian integration: bootstrap public key verifies Sign1",
  () => {
    it("raw COSE from /sign verifies with PEM from /public (digest payload profile)", async () => {
      const env = integration!;
      const pk = await fetchCustodianPublicKey(
        env.url,
        CUSTODIAN_BOOTSTRAP_KEY_ID,
      );
      expect(pk.alg).toBe("ES256");

      const uncompressed = publicKeyPemToUncompressed65(pk.publicKeyPem);
      const grantData = publicKeyToGrantData64(uncompressed);

      const logUuid = "aaaaaaaa-bbbb-4ccc-bddd-111111111111";
      const id16 = uuidToBytes(logUuid);
      const grantBitmap = new Uint8Array(8);
      grantBitmap[4] = 0x03; // GF_CREATE | GF_EXTEND
      grantBitmap[7] = 0x01; // GF_AUTH_LOG

      const grant: Grant = {
        logId: id16,
        ownerLogId: id16,
        grant: grantBitmap,
        maxHeight: 0,
        minGrowth: 0,
        grantData,
      };

      const payloadBytes = encodeGrantPayload(grant);
      const sign1Raw = await postCustodianSignGrantPayload(
        env.url,
        CUSTODIAN_BOOTSTRAP_KEY_ID,
        env.token,
        payloadBytes,
      );

      const ok = await verifyCustodianEs256GrantSign1(
        sign1Raw,
        pk.publicKeyPem,
      );
      expect(ok).toBe(true);
    });
  },
);
