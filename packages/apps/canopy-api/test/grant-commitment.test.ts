/**
 * Grant commitment for grant-sequencing (Plan 0004 subplan 01/03, Plan 0007).
 * Matches contract formula: preimage then SHA-256.
 */

import { describe, expect, it } from "vitest";
import { decodeGrantResponse } from "../src/grant/codec.js";
import {
  grantCommitmentHashFromGrant,
  grantCommitmentHashToHex,
} from "../src/grant/grant-commitment.js";
import grantVectors from "./fixtures/grant_vectors.json";

function hexToBytesStatic(hex: string): Uint8Array {
  const h = hex.replace(/\s/g, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("grantCommitmentHashFromGrant", () => {
  it("returns 32 bytes", async () => {
    const v = grantVectors[0] as {
      expected_cbor_hex: string;
    };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const { grant } = decodeGrantResponse(bytes);
    const hash = await grantCommitmentHashFromGrant(grant);
    expect(hash.length).toBe(32);
  });

  it("is deterministic for the same grant", async () => {
    const v = grantVectors[0] as { expected_cbor_hex: string };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const { grant } = decodeGrantResponse(bytes);
    const a = await grantCommitmentHashFromGrant(grant);
    const b = await grantCommitmentHashFromGrant(grant);
    expect(a).toEqual(b);
  });

  it("grantCommitmentHashToHex produces 64-char lowercase hex", async () => {
    const v = grantVectors[0] as { expected_cbor_hex: string };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const { grant } = decodeGrantResponse(bytes);
    const hash = await grantCommitmentHashFromGrant(grant);
    const hex = grantCommitmentHashToHex(hash);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
