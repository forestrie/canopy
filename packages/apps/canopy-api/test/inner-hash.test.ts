/**
 * Inner hash for grant-sequencing (Plan 0004 subplan 01/03).
 * Matches go-univocity inner preimage and sha256(inner).
 */

import { describe, expect, it } from "vitest";
import { decodeGrant } from "../src/grant/codec.js";
import {
  innerHashFromGrant,
  innerHashToHex,
} from "../src/grant/inner-hash.js";
import grantVectors from "./fixtures/grant_vectors.json";

function hexToBytesStatic(hex: string): Uint8Array {
  const h = hex.replace(/\s/g, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("innerHashFromGrant", () => {
  it("returns 32 bytes", async () => {
    const v = grantVectors[0] as {
      idtimestamp_hex: string;
      log_id_hex: string;
      owner_log_id_hex: string;
      grant_flags_hex: string;
      max_height: number;
      min_growth: number;
      grant_data_hex: string;
      signer_hex: string;
      kind: number;
      expected_cbor_hex: string;
    };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const grant = decodeGrant(bytes);
    const inner = await innerHashFromGrant(grant);
    expect(inner.length).toBe(32);
  });

  it("is deterministic for the same grant", async () => {
    const v = grantVectors[0] as { expected_cbor_hex: string };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const grant = decodeGrant(bytes);
    const a = await innerHashFromGrant(grant);
    const b = await innerHashFromGrant(grant);
    expect(a).toEqual(b);
  });

  it("innerHashToHex produces 64-char lowercase hex", async () => {
    const v = grantVectors[0] as { expected_cbor_hex: string };
    const bytes = hexToBytesStatic(v.expected_cbor_hex);
    const grant = decodeGrant(bytes);
    const inner = await innerHashFromGrant(grant);
    const hex = innerHashToHex(inner);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
