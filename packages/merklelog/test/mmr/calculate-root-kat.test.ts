import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { calculateRoot, verifyInclusion } from "../../src/mmr/algorithms.js";
import type { Proof } from "../../src/mmr/types.js";
import { Sha256Hasher } from "../helpers/sha256-hasher.js";

/** 8-byte big-endian, matching go `HashWriteUint64` / Python `pos.to_bytes(8,"big")`. */
function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/**
 * Non-circular known-answer test for interior-node hashing.
 *
 * The reference spec (draft-bryce-cose-receipts-mmr-profile / algorithms.py
 * `included_root` + `hash_pospair64`) and go-merklelog both compute interior
 * MMR nodes as `H(pos_BE8 || left || right)`, where `pos` is the 1-based node
 * position. This pins `calculateRoot` to that wire format independently of the
 * implementation (no round-tripping `calculateRoot` against itself).
 */
describe("calculateRoot interior node hashing (KAT)", () => {
  // Two-leaf MMR, size 3: node 0 = leaf0, node 1 = leaf1, node 2 = peak.
  // Peak position (1-based) = 3.
  const leaf0 = new Uint8Array(32).fill(0xa0);
  const leaf1 = new Uint8Array(32).fill(0xb1);

  it("reconstructs the size-3 peak as H(pos=3 || leaf0 || leaf1)", async () => {
    const hasher = new Sha256Hasher();
    const expectedPeak = sha256(u64be(3n), leaf0, leaf1);

    // Prove leaf1 (mmrIndex 1); its sibling witness is leaf0 (node 0).
    const proof: Proof = { path: [leaf0], mmrIndex: 1n };
    const root = await calculateRoot(hasher, leaf1, proof, 1n);

    expect(Buffer.from(root).toString("hex")).toBe(
      Buffer.from(expectedPeak).toString("hex"),
    );
  });

  it("verifyInclusion accepts the position-committed peak", async () => {
    const hasher = new Sha256Hasher();
    const peak = sha256(u64be(3n), leaf0, leaf1);
    const proof: Proof = { path: [leaf0], mmrIndex: 1n };
    expect(await verifyInclusion(hasher, leaf1, proof, peak)).toBe(true);
  });
});
