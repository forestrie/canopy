/**
 * Build Forestrie-Grant transparent statements matching Custodian COSE profile (Plan 0014)
 * for tests: Sign1 payload = SHA-256(grant v0 CBOR); unprotected -65538 = grant payload.
 */

import { encodeCborBstr, encodeSigStructure } from "@canopy/encoding";
import { encode as encodeCbor } from "cbor-x";
import { sha256 } from "@noble/hashes/sha256";
import { encodeGrantPayload } from "../../src/grant/codec.js";
import type { Grant } from "../../src/grant/types.js";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
} from "../../src/grant/transparent-statement.js";

/**
 * Encode Authorization header value: `Forestrie-Grant <base64>` for a custodian-profile statement.
 */
export async function forestrieGrantAuthorizationHeader(
  grant: Grant,
  privateKey: CryptoKey,
  kid16: Uint8Array,
  idtimestamp: Uint8Array = new Uint8Array(8),
): Promise<string> {
  const bytes = await encodeCustodianProfileForestrieGrant(
    grant,
    privateKey,
    kid16,
    idtimestamp,
  );
  const base64 = btoa(String.fromCharCode(...bytes));
  return `Forestrie-Grant ${base64}`;
}

export async function encodeCustodianProfileForestrieGrant(
  grant: Grant,
  privateKey: CryptoKey,
  kid16: Uint8Array,
  idtimestamp: Uint8Array,
): Promise<Uint8Array> {
  if (kid16.length !== 16) {
    throw new Error("kid must be 16 bytes (Custodian profile)");
  }
  const grantPayload = encodeGrantPayload(grant);
  const digest = sha256(grantPayload);
  const protectedMap = new Map<number, unknown>([
    [1, -7],
    [3, "application/forestrie.custodian-statement+cbor"],
    [4, kid16],
  ]);
  const protectedInner = new Uint8Array(encodeCbor(protectedMap));
  const sigStructure = encodeSigStructure(
    encodeCborBstr(protectedInner),
    new Uint8Array(0),
    digest,
  );
  const sigBuffer = sigStructure.buffer.slice(
    sigStructure.byteOffset,
    sigStructure.byteOffset + sigStructure.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    sigBuffer,
  );
  const unprot = new Map<number, Uint8Array>([
    [HEADER_IDTIMESTAMP, idtimestamp],
    [HEADER_FORESTRIE_GRANT_V0, grantPayload],
  ]);
  const cose = [
    protectedInner,
    unprot,
    digest,
    new Uint8Array(signature),
  ];
  return new Uint8Array(encodeCbor(cose));
}
