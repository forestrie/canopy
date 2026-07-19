/**
 * FOR-289 golden vectors: committed .cbor fixtures verified against the
 * CURRENT verifier. Unlike the generated fixtures (which co-evolve with the
 * code), these bytes are frozen — if the verifier's wire-format expectations
 * drift incompatibly, these tests fail even though the generated-fixture
 * tests still pass. Regeneration is a deliberate act
 * (scripts/export-golden-vectors.ts), never a casual fix for a red test.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyGrantReceiptOffline } from "../src/index.js";
import { grantWithData } from "./helpers/grant-receipt-fixture.js";

const dir = join(import.meta.dirname, "fixtures", "golden");
const manifest = JSON.parse(
  readFileSync(join(dir, "manifest.json"), "utf8"),
) as {
  logId: string;
  grantDataHex: string;
  idtimestampBe8Hex: string;
  genesisSha256: string;
  receiptSha256: string;
};
const genesisCbor = new Uint8Array(
  readFileSync(join(dir, "grant-genesis.cbor")),
);
const receiptCbor = new Uint8Array(
  readFileSync(join(dir, "grant-receipt.cbor")),
);
const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const grant = grantWithData(manifest.logId, fromHex(manifest.grantDataHex));
const idtimestampBe8 = fromHex(manifest.idtimestampBe8Hex);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("golden vectors (FOR-289 — frozen bytes)", () => {
  it("committed fixtures match their recorded digests (no accidental edits)", () => {
    expect(sha256(genesisCbor)).toBe(manifest.genesisSha256);
    expect(sha256(receiptCbor)).toBe(manifest.receiptSha256);
  });

  it("the frozen receipt verifies against the frozen genesis", async () => {
    const result = await verifyGrantReceiptOffline({
      genesisCbor,
      receiptCbor,
      grant,
      idtimestampBe8,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("a flipped receipt byte fails", async () => {
    const tampered = receiptCbor.slice();
    tampered[tampered.length - 1]! ^= 0xff;
    const result = await verifyGrantReceiptOffline({
      genesisCbor,
      receiptCbor: tampered,
      grant,
      idtimestampBe8,
    });
    expect(result.ok).toBe(false);
  });

  it("a flipped genesis byte fails", async () => {
    const tampered = genesisCbor.slice();
    tampered[tampered.length - 1]! ^= 0xff;
    const result = await verifyGrantReceiptOffline({
      genesisCbor: tampered,
      receiptCbor,
      grant,
      idtimestampBe8,
    });
    expect(result.ok).toBe(false);
  });

  it("a wrong idtimestamp fails", async () => {
    const wrong = idtimestampBe8.slice();
    wrong[7]! ^= 0x01;
    const result = await verifyGrantReceiptOffline({
      genesisCbor,
      receiptCbor,
      grant,
      idtimestampBe8: wrong,
    });
    expect(result.ok).toBe(false);
  });
});
