/**
 * Cross-language checkpoint-receipt KAT (protocol#10, ADR-0066 D9 as
 * narrowed): `protected_headers` rows exercise {@link readProtectedTreeSize2}
 * directly (accept/absent/reject), and `receipts` rows pin the protected
 * header and Sig_structure encoders against the shared vector's bytes.
 *
 * Vector file: testdata/checkpoint-receipt-kat39.json, pinned by SHA-256
 * below — see
 * https://github.com/forestrie/protocol/blob/main/vectors/checkpoint-receipt-format.md
 * for the row shapes and conventions. This is one of three suites in canopy
 * consuming the same file (the others: packages/merklelog and
 * packages/libs/receipt-verify); do not edit the vector, only this test.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { encodeSigStructure } from "./encode-sig-structure.js";
import { readProtectedTreeSize2 } from "./cose-protected-tree-size.js";
import { bytesToHex, hexToBytes } from "./hex-test.js";

const dir = dirname(fileURLToPath(import.meta.url));

/** Pinned per checkpoint-receipt-format.md / protocol SHA256SUMS. */
const EXPECTED_SHA256 =
  "391d203b99b8dc41226694edee4eab3da3f1aa9bc651d13408d1a21b0986a8b8";

interface ProtectedHeaderRow {
  name: string;
  hex: string;
  note?: string;
  expect:
    | { result: "accept"; tree_size_2: number }
    | { result: "absent" }
    | { result: "reject"; reason: string };
}

interface ReceiptRow {
  name: string;
  alg: number;
  alg_name: string;
  tree_size_1: number;
  tree_size_2: number;
  protected_header_hex: string;
  sig_structure_hex: string;
  detached_payload_hex: string;
}

interface Kat39File {
  protected_headers: ProtectedHeaderRow[];
  receipts: ReceiptRow[];
}

function loadVector(): { raw: string; data: Kat39File } {
  const raw = readFileSync(
    join(dir, "testdata", "checkpoint-receipt-kat39.json"),
    "utf8",
  );
  return { raw, data: JSON.parse(raw) as Kat39File };
}

describe("checkpoint-receipt-kat39.json (protocol#10)", () => {
  it("the vendored copy matches the pinned SHA-256", () => {
    const { raw } = loadVector();
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      EXPECTED_SHA256,
    );
  });
});

describe("readProtectedTreeSize2 vs KAT39 protected_headers", () => {
  const { data } = loadVector();

  for (const row of data.protected_headers) {
    it(`${row.name}: ${row.expect.result}`, () => {
      const bytes = hexToBytes(row.hex);
      if (row.expect.result === "accept") {
        expect(readProtectedTreeSize2(bytes)).toBe(
          BigInt(row.expect.tree_size_2),
        );
      } else if (row.expect.result === "absent") {
        expect(readProtectedTreeSize2(bytes)).toBeNull();
      } else {
        expect(() => readProtectedTreeSize2(bytes)).toThrow();
      }
    });
  }
});

describe("protected-header + Sig_structure encoders vs KAT39 receipts", () => {
  const { data } = loadVector();

  for (const row of data.receipts) {
    it(`${row.name}: protected header and Sig_structure bytes`, () => {
      const protectedBstr = encodeCborDeterministic(
        new Map<number, unknown>([
          [1, row.alg],
          [395, 3],
          [-65933, row.tree_size_2],
        ]),
      );
      expect(bytesToHex(protectedBstr)).toBe(row.protected_header_hex);

      const payload = hexToBytes(row.detached_payload_hex);
      const sigStructure = encodeSigStructure(
        protectedBstr,
        new Uint8Array(0),
        payload,
      );
      expect(bytesToHex(sigStructure)).toBe(row.sig_structure_hex);
    });
  }
});
