/**
 * One-shot exporter for the FOR-289 golden vectors.
 *
 * Generates a grant-receipt fixture (test/helpers/grant-receipt-fixture.ts)
 * and freezes its bytes under test/fixtures/golden/ together with a manifest
 * (grant reconstruction inputs + sha256 of each blob).
 *
 * The committed vectors are FROZEN: regenerating them changes the bytes the
 * golden test guards, which defeats its purpose (catching wire-format drift
 * in the verifier). Re-run only for a deliberate, reviewed format migration:
 *
 *   bun scripts/export-golden-vectors.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildGrantReceiptFixture } from "../test/helpers/grant-receipt-fixture.js";

const outDir = join(import.meta.dirname, "..", "test", "fixtures", "golden");
mkdirSync(outDir, { recursive: true });

const fx = await buildGrantReceiptFixture();

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

writeFileSync(join(outDir, "grant-genesis.cbor"), fx.genesisCbor);
writeFileSync(join(outDir, "grant-receipt.cbor"), fx.receiptCbor);

const manifest = {
  comment:
    "FOR-289 golden vectors — FROZEN bytes; see scripts/export-golden-vectors.ts",
  logId: "660e8400-e29b-41d4-a716-446655440001",
  grantDataHex: hex(fx.grant.grantData),
  idtimestampBe8Hex: hex(fx.idtimestampBe8),
  genesisSha256: sha256(fx.genesisCbor),
  receiptSha256: sha256(fx.receiptCbor),
};
writeFileSync(
  join(outDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
