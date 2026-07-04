import { describe, expect, it } from "vitest";
import { encode as encodeCbor } from "cbor-x";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import {
  buildGrantReceiptFixture,
  generateP256KeyPair,
} from "./helpers/grant-receipt-fixture.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_SCHEMA_V2,
} from "../src/forest-genesis-labels.js";
import { COSE_ALG_ES256 } from "../src/cose-key.js";

describe("verifyGrantReceiptOffline negatives", () => {
  it("rejects_tampered_receipt", async () => {
    const fx = await buildGrantReceiptFixture();
    const tampered = new Uint8Array(fx.receiptCbor);
    tampered[tampered.length - 1] ^= 0xff;
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: tampered,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
  });

  it("rejects_wrong_genesis_key", async () => {
    const fx = await buildGrantReceiptFixture();
    const other = await generateP256KeyPair();
    const otherRaw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", other.publicKey)) as ArrayBuffer,
    );
    const wrongGenesis = new Uint8Array(
      encodeCbor(
        new Map<number, unknown>([
          [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
          [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
          [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, otherRaw.slice(1)],
        ]),
      ),
    );
    const result = await verifyGrantReceiptOffline({
      genesisCbor: wrongGenesis,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "signature",
      reason: "signature_invalid",
    });
  });

  it("rejects_wrong_idtimestamp", async () => {
    const fx = await buildGrantReceiptFixture();
    const wrongTs = new Uint8Array(8).fill(0x99);
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: wrongTs,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "signature",
      reason: "signature_invalid",
    });
  });

  it("rejects_truncated_proof_396", async () => {
    const fx = await buildGrantReceiptFixture();
    const decoded = encodeCbor([
      new Uint8Array(encodeCbor(new Map([[1, -7]]))),
      new Map<number, unknown>(),
      null,
      new Uint8Array(64).fill(1),
    ]);
    const badReceipt = new Uint8Array(decoded);
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: badReceipt,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "parse",
      reason: "receipt_malformed",
    });
  });

  it("rejects_wrong_grant_commitment", async () => {
    const fx = await buildGrantReceiptFixture();
    const wrongGrant = {
      ...fx.grant,
      grantData: new Uint8Array(64).fill(0xfe),
    };
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: wrongGrant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "signature",
      reason: "signature_invalid",
    });
  });

  it("detached_peak_sig_failure_not_inclusion_ok", async () => {
    const fx = await buildGrantReceiptFixture();
    const other = await generateP256KeyPair();
    const otherRaw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", other.publicKey)) as ArrayBuffer,
    );
    const wrongGenesis = new Uint8Array(
      encodeCbor(
        new Map<number, unknown>([
          [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
          [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
          [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, otherRaw.slice(1)],
        ]),
      ),
    );
    const result = await verifyGrantReceiptOffline({
      genesisCbor: wrongGenesis,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "signature",
      reason: "signature_invalid",
    });
  });
});
