/**
 * Optional integration: custody key create + sign roundtrip (ES256, digest payload profile).
 * Enable with CUSTODIAN_URL + CUSTODIAN_APP_TOKEN (or CUSTODIAN_INTEGRATION_*). Skips when unset (CI).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env as cloudflareTestEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeGrantPayload } from "../src/grant/codec.js";
import type { Grant } from "../src/grant/grant.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  fetchCustodianPublicKey,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
  verifyCustodianEs256GrantSign1WithGrantDataXy,
} from "../src/scrapi/custodian-grant.js";

function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error("invalid key length");
}

function custodianKmsCryptoKeyIdFromLogUuid(logId: string): string {
  const compact = logId.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error(
      `selfLogId must be a UUID (32 hex digits); got length ${compact.length}`,
    );
  }
  return compact;
}

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

async function postCustodianCreateEs256Key(opts: {
  baseUrl: string;
  appToken: string;
  keyOwnerId: string;
  selfLogId: string;
}): Promise<{ keyId: string; publicKeyPem: string }> {
  const base = trimBase(opts.baseUrl);
  const body: Record<string, unknown> = {
    keyOwnerId: opts.keyOwnerId,
    selfLogId: opts.selfLogId,
    alg: "ES256",
  };
  const encoded = encodeCbor(body);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: bodyBuf,
  });
  if (!res.ok) {
    throw new Error(
      `Custodian create key: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  const raw = decodeCbor(new Uint8Array(await res.arrayBuffer())) as unknown;
  const fields =
    raw instanceof Map
      ? Object.fromEntries([...raw.entries()].map(([k, v]) => [String(k), v]))
      : (raw as Record<string, unknown>);
  const keyId = fields.keyId;
  const publicKey = fields.publicKey;
  if (typeof keyId !== "string" || typeof publicKey !== "string") {
    throw new Error("Custodian create key: missing keyId or publicKey");
  }
  return { keyId, publicKeyPem: publicKey };
}

function integrationEnv(): { url: string; token: string } | null {
  const cf = cloudflareTestEnv as {
    CUSTODIAN_URL?: string;
    CUSTODIAN_APP_TOKEN?: string;
  };
  const url =
    process.env.CUSTODIAN_INTEGRATION_URL?.trim() ||
    cf.CUSTODIAN_URL?.trim() ||
    process.env.CUSTODIAN_URL?.trim();
  const token =
    process.env.CUSTODIAN_INTEGRATION_APP_TOKEN?.trim() ||
    cf.CUSTODIAN_APP_TOKEN?.trim() ||
    process.env.CUSTODIAN_APP_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

const integration = integrationEnv();

describe.skipIf(!integration)(
  "Custodian integration: custody public key verifies Sign1",
  () => {
    it("raw COSE from /sign verifies with grantData x‖y from create-key PEM (digest payload profile)", async () => {
      const env = integration!;
      const logUuid = crypto.randomUUID();
      const { keyId, publicKeyPem } = await postCustodianCreateEs256Key({
        baseUrl: env.url,
        appToken: env.token,
        keyOwnerId: custodianKmsCryptoKeyIdFromLogUuid(crypto.randomUUID()),
        selfLogId: logUuid,
      });
      const kmsSegment = keyId.split("/cryptoKeys/").pop() ?? keyId;
      expect(custodianKmsCryptoKeyIdFromLogUuid(logUuid)).toBe(kmsSegment);

      const pk = await fetchCustodianPublicKey(env.url, kmsSegment);
      expect(pk.alg).toBe("ES256");
      expect(pk.publicKeyPem).toBe(publicKeyPem);

      const uncompressed = publicKeyPemToUncompressed65(pk.publicKeyPem);
      const grantData = publicKeyToGrantData64(uncompressed);

      const id16 = uuidToBytes(logUuid);
      const grantBitmap = new Uint8Array(8);
      grantBitmap[4] = 0x03;
      grantBitmap[7] = 0x01;

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
        kmsSegment,
        env.token,
        payloadBytes,
      );

      const ok = await verifyCustodianEs256GrantSign1WithGrantDataXy(
        sign1Raw,
        grantData,
      );
      expect(ok).toBe(true);
    });
  },
);
