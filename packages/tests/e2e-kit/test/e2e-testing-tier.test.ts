import { describe, expect, test } from "vitest";
import {
  isEphemeralBootstrapTier,
  parseE2eTestingTier,
} from "../src/e2e-testing-tier.js";

describe("e2e testing tier", () => {
  test("defaults to t3", () => {
    expect(parseE2eTestingTier()).toBe("t3");
    expect(parseE2eTestingTier("")).toBe("t3");
    expect(parseE2eTestingTier("  ")).toBe("t3");
  });

  test("parses t2 and t3", () => {
    expect(parseE2eTestingTier("t2")).toBe("t2");
    expect(parseE2eTestingTier("T2")).toBe("t2");
    expect(parseE2eTestingTier("t3")).toBe("t3");
  });

  test("isEphemeralBootstrapTier is true only for t2", () => {
    expect(isEphemeralBootstrapTier("t2")).toBe(true);
    expect(isEphemeralBootstrapTier("t3")).toBe(false);
    expect(isEphemeralBootstrapTier()).toBe(false);
  });
});
