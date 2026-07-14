/**
 * FOR-297: offline verification of a DELEGATED-key-signed grant receipt via the
 * label-1000 delegation certificate chained to the genesis root.
 */

import { describe, expect, it } from "vitest";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import { buildDelegatedGrantReceiptFixture } from "./helpers/delegated-receipt-fixture.js";

describe("verifyGrantReceiptOffline — delegated (FOR-297)", () => {
  it("verifies a delegated-key-signed receipt via the label-1000 cert", async () => {
    const fx = await buildDelegatedGrantReceiptFixture();
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("rejects a delegation cert signed by a non-genesis root", async () => {
    const fx = await buildDelegatedGrantReceiptFixture({ wrongRoot: true });
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
    expect(result.reason).toBe("delegation_invalid");
  });

  it("rejects a delegated-signed receipt with no delegation cert", async () => {
    // No cert → the verifier only has the root key, which cannot verify a
    // delegated signature: signature_invalid (not delegation_invalid).
    const fx = await buildDelegatedGrantReceiptFixture({ omitCert: true });
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("signature");
    expect(result.reason).toBe("signature_invalid");
  });
});
