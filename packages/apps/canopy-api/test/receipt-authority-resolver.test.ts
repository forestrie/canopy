/**
 * Unit tests for receipt authority resolver factory (no Workers pool).
 */

import { describe, expect, it } from "vitest";
import { createReceiptAuthorityResolver } from "../src/env/receipt-authority-resolver.js";

describe("createReceiptAuthorityResolver", () => {
  it("returns an async resolver in dev mode", () => {
    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.example/v1",
      nodeEnv: "dev",
    });
    expect(typeof resolve).toBe("function");
  });

  it("returns an async resolver in pool test mode when test xy hex is configured", () => {
    const resolve = createReceiptAuthorityResolver({
      trustRootUrl: "https://custodian.example/v1",
      nodeEnv: "test",
      testReceiptVerifyEs256XyHex: "11".repeat(64),
    });
    expect(typeof resolve).toBe("function");
  });
});
