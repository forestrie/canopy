/**
 * Isolated reproduction: grant-pool signer → grant request CBOR → API decode →
 * COSE kid → getSignerFromCoseSign1 → signerMatchesGrant.
 *
 * Verifies that the signer is consistent across:
 * - generate-grant-pool script (grant request CBOR via @canopy/encoding, pool JSON hex)
 * - k6 (signerToBytes from pool, encodeCoseSign1WithKid)
 * - API (decodeGrant wire format key 7 = signer, getSignerFromCoseSign1, signerMatchesGrant)
 */

import { describe, expect, it } from "vitest";
import { decodeGrantPayload } from "../src/grant/codec.js";
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
const KIND_BYTES = 1;

describe("Grant pool signer consistency (script ↔ API ↔ k6)", () => {
  const signer = new Uint8Array(32);
  for (let i = 0; i < 32; i++) signer[i] = i + 1;

  const logId = new Uint8Array(LOG_ID_BYTES);
  logId.set([
    0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66,
    0x55, 0x44, 0x00, 0x00,
  ]);
  const ownerLogId = new Uint8Array(LOG_ID_BYTES);
  ownerLogId.set(logId);
  const grantFlags = new Uint8Array(GRANT_FLAGS_BYTES);
  const grantData = new Uint8Array(0);
  const kind = new Uint8Array(KIND_BYTES);

  it("grant request CBOR (grant content 1–8) decodes so signer equals original", () => {
    const body = encodeGrantRequestCbor(
      logId,
      ownerLogId,
      grantFlags,
      grantData,
      signer,
      kind,
    );
    const decoded = decodeGrantPayload(body);
    expect(decoded.signer).toBeDefined();
    expect(decoded.signer.length).toBe(32);
    expect(new Uint8Array(decoded.signer)).toEqual(signer);
  });

  it("pool hex round-trip: signerBytesToHex then hexToSignerBytes equals original", () => {
    const hex = signerBytesToHex(signer);
    expect(hex.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
    const back = hexToSignerBytes(hex);
    expect(back).toEqual(signer);
  });

  it("full chain: grant request signer → COSE kid → getSignerFromCoseSign1 → signerMatchesGrant", () => {
    const body = encodeGrantRequestCbor(
      logId,
      ownerLogId,
      grantFlags,
      grantData,
      signer,
      kind,
    );
    const decoded = decodeGrantPayload(body);
    const grantSigner = decoded.signer;
    expect(new Uint8Array(grantSigner)).toEqual(signer);

    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, grantSigner);
    const statementSigner = getSignerFromCoseSign1(coseSign1);
    expect(statementSigner).not.toBeNull();
    expect(statementSigner!).toEqual(signer);
    expect(signerMatchesGrant(statementSigner, grantSigner)).toBe(true);
  });

  it("full chain via pool hex (k6 path): hex → signerToBytes → COSE → API decode → match", () => {
    const hex = signerBytesToHex(signer);
    const signerBytes = hexToSignerBytes(hex);
    expect(signerBytes).toEqual(signer);

    const payload = new Uint8Array(64);
    const coseSign1 = encodeCoseSign1WithKid(payload, signerBytes);
    const statementSigner = getSignerFromCoseSign1(coseSign1);
    expect(statementSigner).not.toBeNull();
    expect(signerMatchesGrant(statementSigner, signer)).toBe(true);
  });
});
