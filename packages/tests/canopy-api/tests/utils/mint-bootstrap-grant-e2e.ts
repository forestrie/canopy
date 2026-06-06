/**
 * Runner-side bootstrap mint: per-root `POST /api/keys` (custody ES256) + curator genesis
 * + sign with that key (Plan 0019). No Custodian `:bootstrap` alias.
 */

import type { APIRequestContext } from "@playwright/test";
import { encodeGrantPayload } from "@e2e-canopy-api-src/grant/codec.js";
import type { Grant } from "@e2e-canopy-api-src/grant/grant.js";
import { uuidToBytes } from "@e2e-canopy-api-src/grant/uuid-bytes.js";
import {
  mergeGrantHeadersIntoCustodianSign1,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
} from "@e2e-canopy-api-src/scrapi/custodian-grant.js";
import { ensureForestGenesisEs256E2e } from "./forest-genesis-e2e.js";
import {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
} from "@e2e-canopy-api-src/forest/forest-genesis-labels.js";
import {
  custodianKmsCryptoKeyIdFromLogUuid,
  postCustodianEnsureEs256Key,
} from "./custodian-custody-grant.js";

function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error("invalid key length for grantData x‖y");
}

export async function mintTransparentBootstrapGrantBase64(opts: {
  request: APIRequestContext;
  rootLogId: string;
  curatorToken: string;
  custodianUrl: string;
  custodianAppToken: string;
  /** Optional real chain binding (defaults to KS256 contract + Base Sepolia). */
  univocityAddr?: Uint8Array;
  chainId?: string;
}): Promise<{ grantBase64: string; rootCustodySignKeyId: string }> {
  const univocityAddr =
    opts.univocityAddr ?? FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR;
  const chainId = opts.chainId ?? FOREST_GENESIS_E2E_DUMMY_CHAIN_ID;

  const { keyId, publicKeyPem } = await postCustodianEnsureEs256Key({
    baseUrl: opts.custodianUrl,
    appToken: opts.custodianAppToken,
    keyOwnerId: custodianKmsCryptoKeyIdFromLogUuid(opts.rootLogId),
    selfLogId: opts.rootLogId,
  });
  const kmsSegment = keyId.split("/cryptoKeys/").pop() ?? keyId;

  const uncompressed = publicKeyPemToUncompressed65(publicKeyPem);
  const grantData = publicKeyToGrantData64(uncompressed);
  // Bootstrap register-grant verifies the grant against genesis bootstrapKey (ES256
  // x‖y from this Custodian key). Chain binding uses the real KS256 contract address.
  await ensureForestGenesisEs256E2e(opts.request, {
    logId: opts.rootLogId,
    curatorToken: opts.curatorToken,
    bootstrapKey: grantData,
    univocityAddr,
    chainId,
  });
  const id16 = uuidToBytes(opts.rootLogId);
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
    opts.custodianUrl,
    kmsSegment,
    opts.custodianAppToken,
    payloadBytes,
  );
  const merged = mergeGrantHeadersIntoCustodianSign1(sign1Raw, payloadBytes);
  return {
    grantBase64: bytesToForestrieGrantBase64(merged),
    rootCustodySignKeyId: kmsSegment,
  };
}
