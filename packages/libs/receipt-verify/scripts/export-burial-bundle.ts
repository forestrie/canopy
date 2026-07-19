/**
 * One-shot exporter for the FOR-368 burial-bundle golden vectors
 * (plan-2607-29 Phase 4; same discipline as export-golden-vectors.ts).
 *
 * Freezes the retained checkpoint chain, the old-era (buried-peak) receipt
 * and the reconstruction manifest under test/fixtures/golden/burial/. The
 * committed bytes are FROZEN — regenerate only for a deliberate, reviewed
 * format migration:
 *
 *   bun scripts/export-burial-bundle.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildBurialBundleFixture } from "../test/helpers/burial-bundle-fixture.js";

const outDir = join(
  import.meta.dirname,
  "..",
  "test",
  "fixtures",
  "golden",
  "burial",
);
mkdirSync(outDir, { recursive: true });

const fx = await buildBurialBundleFixture();

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const checkpointFiles: string[] = [];
const checkpointSha256: string[] = [];
fx.checkpoints.forEach((cp, i) => {
  const name = `sth-${String(i).padStart(4, "0")}.cbor`;
  writeFileSync(join(outDir, name), cp);
  checkpointFiles.push(name);
  checkpointSha256.push(sha256(cp));
});
writeFileSync(join(outDir, "burial-receipt.cbor"), fx.receiptCbor);

const manifest = {
  comment:
    "FOR-368 burial-bundle golden vectors — FROZEN bytes; see scripts/export-burial-bundle.ts",
  publicKeyXyHex: hex(fx.publicKeyXy),
  leafMmrIndex: fx.leafMmrIndex.toString(),
  leafHashHex: hex(fx.leafHash),
  buriedPeakHex: hex(fx.buriedPeak),
  finalAccumulatorHex: fx.finalAccumulator.map(hex),
  checkpointFiles,
  checkpointSha256,
  receiptSha256: sha256(fx.receiptCbor),
};
writeFileSync(
  join(outDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(JSON.stringify(manifest, null, 2));
