/**
 * Cross-language checkpoint-receipt KAT (protocol#10, ADR-0066 D9 as
 * narrowed): `receipts` rows are decoded (tagged COSE_Sign1) and run end to
 * end through {@link verifyCheckpointChain} from the vector's trusted
 * origin; `receipt_negatives` rows must be rejected; `receipt_chains` rows
 * (relayed multi-proof checkpoints, ADR-0066 D2) are run through
 * {@link checkpointConsistencyProof} and {@link computeCheckpointAccumulator}
 * directly — the decode-and-fold pair {@link verifyCheckpointChain} itself
 * calls per checkpoint — so a reject row's typed error is checked, not just
 * the reason string {@link verifyCheckpointChain} maps it to.
 *
 * Vector file: read via a relative path from encoding's vendored copy
 * (packages/shared/encoding/src/testdata/checkpoint-receipt-kat39.json) —
 * the single copy this repo keeps, per
 * https://github.com/forestrie/protocol/blob/main/vectors/checkpoint-receipt-format.md.
 * This is one of three suites in canopy consuming the same file (the
 * others: packages/shared/encoding and packages/merklelog); do not edit the
 * vector, only this test.
 *
 * KS256 rows (`ks256/*`) are skipped: this package has no KS256 checkpoint
 * verifier. `verifyKs256CoseSign1` (Keccak Sig_structure + ecrecover /
 * ERC-1271) lives in canopy-api (`src/grant/ks256-verify.ts`), depends on
 * `@forestrie/chain-rpc`'s ERC-1271 hooks for the contract-signer path, and
 * is the wrong dependency direction for receipt-verify to import from an
 * app. Building a second, ad-hoc KS256 verifier just for this test would
 * test code nothing in production runs. See the `ks256 rows are not
 * exercised here` describe block below for exactly which rows that skips
 * and why.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeCborUnwrapCose,
  verifyCoseSign1WithParsedKey,
  type ParsedEcPublicKey,
} from "@forestrie/encoding";
import {
  checkpointConsistencyProof,
  computeCheckpointAccumulator,
  verifyCheckpointChain,
  CheckpointSignedSizeMismatchError,
  ConsistencyChainNotContiguousError,
} from "../src/checkpoint-chain.js";

const dir = dirname(fileURLToPath(import.meta.url));

/** Pinned per checkpoint-receipt-format.md / protocol SHA256SUMS. */
const EXPECTED_SHA256 =
  "fb6bbde735537cfc97f83c52cfc4c609b4d1ed1474157910d7be0814456102c8";

interface ReceiptRow {
  name: string;
  alg: number;
  tree_size_1: number;
  tree_size_2: number;
  receipt_cbor_hex: string;
}

interface ReceiptNegativeRow {
  name: string;
  alg: number;
  tree_size_1: number;
  receipt_cbor_hex: string;
  expect: { result: "reject"; reason: string };
  note?: string;
}

interface ReceiptChainRow {
  name: string;
  alg: number;
  alg_name: string;
  trusted_tree_size_1: number;
  receipt_cbor_hex: string;
  expect:
    | { result: "accept"; tree_size_2: number }
    | { result: "reject"; reason: string };
  note?: string;
}

interface Kat39File {
  tree: {
    accumulators: Record<string, { peaks_hex: string[] }>;
  };
  keys: {
    es256: { public_x_hex: string; public_y_hex: string };
  };
  receipts: ReceiptRow[];
  receipt_negatives: ReceiptNegativeRow[];
  receipt_chains: ReceiptChainRow[];
}

function loadVector(): { raw: string; data: Kat39File } {
  const raw = readFileSync(
    join(
      dir,
      "..",
      "..",
      "..",
      "shared",
      "encoding",
      "src",
      "testdata",
      "checkpoint-receipt-kat39.json",
    ),
    "utf8",
  );
  return { raw, data: JSON.parse(raw) as Kat39File };
}

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const { data } = loadVector();

const es256Key: ParsedEcPublicKey = {
  x: fromHex(data.keys.es256.public_x_hex),
  y: fromHex(data.keys.es256.public_y_hex),
  curve: "P-256",
};

const verifyEs256 = (bytes: Uint8Array, detachedPayload: Uint8Array) =>
  verifyCoseSign1WithParsedKey(bytes, es256Key, { detachedPayload });

/** Trusted origin at `size`: the tree's tabulated accumulator, or the empty
 * accumulator for size 0 (no `tree.accumulators` entry exists for size 0). */
function trustedOrigin(size: number): {
  size: bigint;
  accumulator: Uint8Array[];
} {
  if (size === 0) return { size: 0n, accumulator: [] };
  const entry = data.tree.accumulators[String(size)];
  expect(entry, `no tree.accumulators entry for size ${size}`).toBeDefined();
  return { size: BigInt(size), accumulator: entry!.peaks_hex.map(fromHex) };
}

describe("checkpoint-receipt-kat39.json (protocol#10)", () => {
  it("the vendored copy (encoding/src/testdata) matches the pinned SHA-256", () => {
    const { raw } = loadVector();
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      EXPECTED_SHA256,
    );
  });
});

describe("verifyCheckpointChain vs KAT39 receipts (ES256)", () => {
  const es256Rows = data.receipts.filter((r) => r.name.startsWith("es256/"));
  expect(es256Rows.length).toBeGreaterThan(0);

  for (const row of es256Rows) {
    it(`${row.name}: verifies end to end from the trusted origin`, async () => {
      const receiptBytes = fromHex(row.receipt_cbor_hex);
      // Sanity: the fixture really is a tag-18 COSE_Sign1 the shared decoder
      // unwraps, matching the format doc's Receipt byte convention.
      expect(() => decodeCborUnwrapCose(receiptBytes)).not.toThrow();

      const result = await verifyCheckpointChain({
        checkpoints: [receiptBytes],
        verifySignature: verifyEs256,
        trustedBase: trustedOrigin(row.tree_size_1),
      });

      expect(
        result.ok,
        result.ok ? "ok" : `${result.reason} at ${result.at}: ${result.detail}`,
      ).toBe(true);
      if (!result.ok) return;
      expect(result.links.length).toBe(1);
      expect(result.links[0]!.treeSize1).toBe(BigInt(row.tree_size_1));
      expect(result.links[0]!.treeSize2).toBe(BigInt(row.tree_size_2));

      const expectedAccumulator =
        data.tree.accumulators[String(row.tree_size_2)]!.peaks_hex;
      expect(result.accumulator.map(toHex)).toEqual(expectedAccumulator);
      expect(result.links[0]!.accumulator.map(toHex)).toEqual(
        expectedAccumulator,
      );
    });
  }
});

describe("ks256 rows are not exercised here (no KS256 checkpoint verifier in receipt-verify)", () => {
  it("names exactly the receipts rows skipped, so a new row is noticed", () => {
    const ks256Names = data.receipts
      .filter((r) => r.name.startsWith("ks256/"))
      .map((r) => r.name);
    expect(ks256Names).toEqual([
      "ks256/0-to-1",
      "ks256/7-to-8",
      "ks256/4-to-7",
      "ks256/7-to-15",
      "ks256/26-to-39",
    ]);
  });
});

describe("verifyCheckpointChain vs KAT39 receipt_negatives", () => {
  // Vector reason -> this package's CheckpointChainResult.reason. Both
  // "signed_size_mismatch" and "signed_size_missing" surface through
  // checkpointConsistencyProof: a mismatch is the typed
  // CheckpointSignedSizeMismatchError (reason "size_mismatch"); an absent
  // signed size is a plain Error (reason "proof_malformed", the catch-all
  // for "not a size-mismatch, not a high-s signature"). "signature_invalid"
  // is a low-s signature that does not verify over the true payload (reason
  // "signature"). "signature_malleable" is the FOR-568 rollout item 4 high-s
  // rejection, before any WebCrypto verify (reason "signature_malleable").
  const REASON_MAP: Record<string, string> = {
    signed_size_mismatch: "size_mismatch",
    signed_size_missing: "proof_malformed",
    signature_invalid: "signature",
    signature_malleable: "signature_malleable",
  };

  for (const row of data.receipt_negatives) {
    it(`${row.name}: rejects (${row.expect.reason})`, async () => {
      const receiptBytes = fromHex(row.receipt_cbor_hex);
      const result = await verifyCheckpointChain({
        checkpoints: [receiptBytes],
        verifySignature: verifyEs256,
        trustedBase: trustedOrigin(row.tree_size_1),
      });
      expect(result.ok, row.note ?? row.name).toBe(false);
      if (result.ok) return;
      const expectedReason = REASON_MAP[row.expect.reason];
      expect(
        expectedReason,
        `no reason mapping for ${row.expect.reason}`,
      ).toBeDefined();
      expect(result.reason, row.note ?? row.name).toBe(expectedReason);
    });
  }
});

describe("checkpointConsistencyProof + computeCheckpointAccumulator vs KAT39 receipt_chains", () => {
  // Vector reason -> the typed error thrown by the decode
  // (checkpointConsistencyProof) or the fold (computeCheckpointAccumulator)
  // that produces it. "signed_size_mismatch" is the checkpoint's signed
  // tree-size-2 disagreeing with its last relayed proof (caught decoding
  // the checkpoint); "chain_not_contiguous" is a relayed proof whose
  // declared tree-size-1 does not match the size the fold has reached
  // (caught folding the already-decoded proofs).
  const CHAIN_REASON_ERROR: Record<string, new (message: string) => Error> = {
    signed_size_mismatch: CheckpointSignedSizeMismatchError,
    chain_not_contiguous: ConsistencyChainNotContiguousError,
  };

  for (const row of data.receipt_chains) {
    it(`${row.name}: ${row.expect.result}s (${
      row.expect.result === "accept" ? "tree_size_2" : row.expect.reason
    })`, async () => {
      const receiptBytes = fromHex(row.receipt_cbor_hex);
      const base = trustedOrigin(row.trusted_tree_size_1);

      if (row.expect.result === "accept") {
        const proof = checkpointConsistencyProof(receiptBytes);
        const accumulator = await computeCheckpointAccumulator(
          proof,
          base.accumulator,
          base.size,
        );
        expect(proof.treeSize2).toBe(BigInt(row.expect.tree_size_2));
        const expectedAccumulator =
          data.tree.accumulators[String(row.expect.tree_size_2)]!.peaks_hex;
        expect(accumulator.map(toHex)).toEqual(expectedAccumulator);
        return;
      }

      const ErrorClass = CHAIN_REASON_ERROR[row.expect.reason];
      expect(
        ErrorClass,
        `no error mapping for ${row.expect.reason}`,
      ).toBeDefined();
      await expect(async () => {
        const proof = checkpointConsistencyProof(receiptBytes);
        await computeCheckpointAccumulator(proof, base.accumulator, base.size);
      }).rejects.toThrow(ErrorClass!);
    });
  }
});
