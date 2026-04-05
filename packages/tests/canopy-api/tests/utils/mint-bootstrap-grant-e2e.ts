/**
 * Runner-side bootstrap mint: curator genesis + Custodian `:bootstrap` sign (Plan 0019).
 */

import type { APIRequestContext } from "@playwright/test";
import { encodeGrantPayload } from "../../../../apps/canopy-api/src/grant/codec.js";
import type { Grant } from "../../../../apps/canopy-api/src/grant/grant.js";
import { uuidToBytes } from "../../../../apps/canopy-api/src/grant/uuid-bytes.js";
import {
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianPublicKey,
  mergeGrantHeadersIntoCustodianSign1,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
} from "../../../../apps/canopy-api/src/scrapi/custodian-grant.js";
import { ensureForestGenesisE2e } from "./forest-genesis-e2e.js";

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
  custodianBootstrapToken: string;
}): Promise<string> {
  const pk = await fetchCustodianPublicKey(
    opts.custodianUrl,
    CUSTODIAN_BOOTSTRAP_KEY_ID,
  );
  const uncompressed = publicKeyPemToUncompressed65(pk.publicKeyPem);
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  await ensureForestGenesisE2e(opts.request, {
    logId: opts.rootLogId,
    curatorToken: opts.curatorToken,
    x,
    y,
  });

  const grantData = publicKeyToGrantData64(uncompressed);
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
    CUSTODIAN_BOOTSTRAP_KEY_ID,
    opts.custodianBootstrapToken,
    payloadBytes,
  );
  const merged = mergeGrantHeadersIntoCustodianSign1(sign1Raw, payloadBytes);
  return bytesToForestrieGrantBase64(merged);
}
