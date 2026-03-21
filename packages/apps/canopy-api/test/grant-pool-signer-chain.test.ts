/**
 * Grant pool → grant request CBOR → API decode → COSE kid vs grantData binding.
 *
 * Register-statement auth: **GF_DATA_LOG** + **extend** flags and **`statementSignerBindingBytes`**
 * (= **grantData** only; v0 wire has no key 7).
 */

import { describe, expect, it } from "vitest";
import { decodeGrantPayload } from "../src/grant/codec.js";
import { grantDataToBytes } from "../src/grant/grant-data.js";
import { statementSignerBindingBytes } from "../src/grant/statement-signer-binding.js";
import {
  getSignerFromCoseSign1,
  signerMatchesGrant,
} from "../src/scrapi/grant-auth";
import { encodeCoseSign1WithKid } from "./cose-sign1-k6-encoder";
import {
  encodeGrantRequestCbor,
  hexToSignerBytes,
  signerBytesToHex,
} from "./grant-pool-cbor-encoder";

const LOG_ID_BYTES = 16;
const GRANT_FLAGS_BYTES = 8;

function dataLogExtendFlags(): Uint8Array {
  const f = new Uint8Array(GRANT_FLAGS_BYTES);
  f[4] = 0x03; // GF_CREATE | GF_EXTEND
  f[7] = 0x02; // GF_DATA_LOG
  return f;
}

describe("Grant pool signer consistency (script ↔ API ↔ k6)", () => {
  const statementSigner = new Uint8Array(32);
  for (let i = 0; i < 32; i++) statementSigner[i] = i + 1;

  const logId = new Uint8Array(LOG_ID_BYTES);
  logId.set([
    0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66,
    0x55, 0x44, 0x00, 0x00,
  ]);
  const ownerLogId = new Uint8Array(LOG_ID_BYTES);
  ownerLogId.set(logId);
  const grantBitmap = dataLogExtendFlags();
  const grantData = statementSigner;

  it("grant request CBOR decodes to v0 map with grantData = statement signer", () => {
    const body = encodeGrantRequestCbor(
      logId,
      ownerLogId,
      grantBitmap,
      grantData,
    );
    const decoded = decodeGrantPayload(body);
    expect(grantDataToBytes(decoded.grantData)).toEqual(statementSigner);
    expect(statementSignerBindingBytes(decoded)).toEqual(statementSigner);
  });

  it("pool hex round-trip: signerBytesToHex then hexToSignerBytes equals original", () => {
    const hex = signerBytesToHex(statementSigner);
    expect(hex.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
    const back = hexToSignerBytes(hex);
    expect(back).toEqual(statementSigner);
  });

  it("full chain: grantData → statementSignerBindingBytes → COSE kid → match", () => {
    const body = encodeGrantRequestCbor(
      logId,
      ownerLogId,
      grantBitmap,
      grantData,
    );
    const decoded = decodeGrantPayload(body);
    const binding = statementSignerBindingBytes(decoded);
    expect(binding).toEqual(statementSigner);

    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, statementSigner);
    const kid = getSignerFromCoseSign1(coseSign1);
    expect(kid).not.toBeNull();
    expect(kid!).toEqual(statementSigner);
    expect(signerMatchesGrant(kid, binding)).toBe(true);
  });

  it("full chain via pool hex (k6 path)", () => {
    const hex = signerBytesToHex(statementSigner);
    const signerBytes = hexToSignerBytes(hex);
    expect(signerBytes).toEqual(statementSigner);

    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, signerBytes);
    const statementSignerFromCose = getSignerFromCoseSign1(coseSign1);
    expect(signerMatchesGrant(statementSignerFromCose, statementSigner)).toBe(
      true,
    );
  });
});
