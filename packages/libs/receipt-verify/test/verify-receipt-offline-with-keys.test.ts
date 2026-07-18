/**
 * FOR-297 "known log key": offline verification of a delegated-key-signed
 * receipt under CALLER-SUPPLIED trust keys (the log owner's key obtained out
 * of band) instead of the genesis trust root.
 */

import { describe, expect, it } from "vitest";
import { importEs256PublicKeyFromGrantDataXy64 } from "../src/decode-trust-root-cbor.js";
import { verifyGrantReceiptOfflineWithKeys } from "../src/verify-grant-receipt-offline.js";
import { buildDelegatedGrantReceiptFixture } from "./helpers/delegated-receipt-fixture.js";

describe("verifyGrantReceiptOfflineWithKeys — caller-known owner key (FOR-297)", () => {
  it("verifies a delegated receipt under the caller-known owner key, no genesis", async () => {
    const fx = await buildDelegatedGrantReceiptFixture();
    const ownerKey = await importEs256PublicKeyFromGrantDataXy64(
      fx.ownerPublicKeyXy,
    );
    const result = await verifyGrantReceiptOfflineWithKeys({
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [ownerKey],
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("rejects when the caller-known key is not the cert issuer", async () => {
    const fx = await buildDelegatedGrantReceiptFixture();
    const wrongKey = await importEs256PublicKeyFromGrantDataXy64(
      (await buildDelegatedGrantReceiptFixture()).ownerPublicKeyXy,
    );
    const result = await verifyGrantReceiptOfflineWithKeys({
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [wrongKey],
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
    expect(result.reason).toBe("delegation_invalid");
  });

  it("rejects with no trust keys at all", async () => {
    const fx = await buildDelegatedGrantReceiptFixture();
    const result = await verifyGrantReceiptOfflineWithKeys({
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [],
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
    expect(result.reason).toBe("no_es256_trust_key");
  });
});
