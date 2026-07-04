import { describe, expect, it } from "vitest";
import { verifyGrantReceiptOffline } from "../src/verify-grant-receipt-offline.js";
import { buildGrantReceiptFixture } from "./helpers/grant-receipt-fixture.js";

describe("verifyGrantReceiptOffline", () => {
  it("verifies a root-signed grant receipt against genesis trust anchor", async () => {
    const fx = await buildGrantReceiptFixture();
    const result = await verifyGrantReceiptOffline({
      genesisCbor: fx.genesisCbor,
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });
});
