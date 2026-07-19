/**
 * FOR-368 burial-bundle golden vectors (plan-2607-29 Phase 4): FROZEN
 * bytes proving the offline burial story stays verifiable across verifier
 * versions. The bundle is a retained checkpoint chain plus an old-era
 * receipt whose peak the log has since BURIED — the exact honest-receipt
 * scenario FOR-368 exists for. No network, no tiles: everything verifies
 * from the committed bytes + the frozen public key.
 *
 * Regeneration (scripts/export-burial-bundle.ts) is a deliberate act,
 * never a casual fix for a red test.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import { calculateRoot } from "@forestrie/merklelog";
import {
  importEs256PublicKeyFromGrantDataXy64,
  parseReceipt,
  verifyCheckpointChain,
} from "../src/index.js";
import { accumulatorPayload } from "../src/checkpoint-chain.js";
import { SubtleHasher } from "../src/subtle-hasher.js";

const dir = join(import.meta.dirname, "fixtures", "golden", "burial");
const manifest = JSON.parse(
  readFileSync(join(dir, "manifest.json"), "utf8"),
) as {
  publicKeyXyHex: string;
  leafMmrIndex: string;
  leafHashHex: string;
  buriedPeakHex: string;
  finalAccumulatorHex: string[];
  checkpointFiles: string[];
  checkpointSha256: string[];
  receiptSha256: string;
};

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const checkpoints = manifest.checkpointFiles.map(
  (f) => new Uint8Array(readFileSync(join(dir, f))),
);
const receiptCbor = new Uint8Array(
  readFileSync(join(dir, "burial-receipt.cbor")),
);
const buriedPeak = fromHex(manifest.buriedPeakHex);

async function trustKey(): Promise<CryptoKey> {
  return importEs256PublicKeyFromGrantDataXy64(
    fromHex(manifest.publicKeyXyHex),
  );
}

async function foldChain(chain: Uint8Array[]) {
  const key = await trustKey();
  return verifyCheckpointChain({
    checkpoints: chain,
    verifySignature: (bytes, detachedPayload) =>
      verifyCoseSign1WithParsedKey(bytes, key, { detachedPayload }),
  });
}

describe("burial-bundle golden vectors (FOR-368 — frozen bytes)", () => {
  it("committed fixtures match their recorded digests (no accidental edits)", () => {
    checkpoints.forEach((cp, i) => {
      expect(sha256(cp)).toBe(manifest.checkpointSha256[i]!);
    });
    expect(sha256(receiptCbor)).toBe(manifest.receiptSha256);
  });

  it("the frozen chain folds to the frozen final accumulator", async () => {
    const chain = await foldChain(checkpoints);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    expect(chain.links.length).toBe(manifest.checkpointFiles.length);
    expect(chain.accumulator.map((p) => Buffer.from(p).toString("hex"))).toEqual(
      manifest.finalAccumulatorHex,
    );
  });

  it("the old receipt's peak recomputes, its signature verifies, and it is BURIED yet proven", async () => {
    const { proof } = parseReceipt(receiptCbor);
    const leafIdx = proof.leafIndex ?? proof.mmrIndex!;
    expect(leafIdx).toBe(BigInt(manifest.leafMmrIndex));
    const peak = await calculateRoot(
      new SubtleHasher(),
      fromHex(manifest.leafHashHex),
      proof,
      leafIdx,
    );
    expect(bytesEqual(peak, buriedPeak)).toBe(true);
    expect(
      await verifyCoseSign1WithParsedKey(receiptCbor, await trustKey(), {
        detachedPayload: peak,
      }),
    ).toBe(true);

    const chain = await foldChain(checkpoints);
    expect(chain.ok).toBe(true);
    if (!chain.ok) return;
    // Buried: absent from the final accumulator...
    expect(
      chain.accumulator.some((p) => bytesEqual(p, buriedPeak)),
    ).toBe(false);
    // ...yet proven: present in an authenticated EARLIER link, whose later
    // links' signed proofs commit it forward (the FOR-368 acceptance
    // criterion: honest receipts never fail as tamper under growth).
    expect(
      chain.links[0]!.accumulator.some((p) => bytesEqual(p, buriedPeak)),
    ).toBe(true);
  });

  it("any flipped byte in any checkpoint breaks the fold", async () => {
    for (let i = 0; i < checkpoints.length; i++) {
      const mutated = checkpoints.map((cp) => cp.slice());
      // Last byte sits inside the signature bstr for every link.
      mutated[i]![mutated[i]!.length - 1]! ^= 0xff;
      const chain = await foldChain(mutated);
      expect(chain.ok).toBe(false);
      if (!chain.ok) expect(chain.at).toBe(i);
    }
  });

  it("a flipped receipt byte fails signature verification over the recomputed peak", async () => {
    const tampered = receiptCbor.slice();
    tampered[tampered.length - 1]! ^= 0xff;
    const { proof } = parseReceipt(tampered);
    const peak = await calculateRoot(
      new SubtleHasher(),
      fromHex(manifest.leafHashHex),
      proof,
      proof.leafIndex ?? proof.mmrIndex!,
    );
    expect(
      await verifyCoseSign1WithParsedKey(tampered, await trustKey(), {
        detachedPayload: peak,
      }),
    ).toBe(false);
  });

  it("a wrong leaf hash cannot reach the buried peak (payload binding)", async () => {
    const { proof } = parseReceipt(receiptCbor);
    const wrongLeaf = fromHex(manifest.leafHashHex);
    wrongLeaf[0]! ^= 0xff;
    const peak = await calculateRoot(
      new SubtleHasher(),
      wrongLeaf,
      proof,
      proof.leafIndex ?? proof.mmrIndex!,
    );
    expect(bytesEqual(peak, buriedPeak)).toBe(false);
  });
});
