import { describe, expect, it } from "vitest";
import {
  computeRetryWaitMs,
  parseRetryConfig,
} from "../../src/webhook/retry-config.js";

describe("parseRetryConfig", () => {
  it("uses defaults when env vars are unset", () => {
    const config = parseRetryConfig({} as import("../../src/env.js").Env);
    expect(config.retryLadder).toEqual([1, 2, 4, 8]);
    expect(config.retryScaleMs).toBe(1000);
  });

  it("parses ladder and scale from env", () => {
    const config = parseRetryConfig({
      WEBHOOK_RETRY_LADDER: "[1,3]",
      WEBHOOK_RETRY_SCALE_MS: "500",
    } as import("../../src/env.js").Env);
    expect(config.retryLadder).toEqual([1, 3]);
    expect(config.retryScaleMs).toBe(500);
  });
});

describe("computeRetryWaitMs", () => {
  it("honors ladder multipliers and jitter bound", () => {
    const config = { retryLadder: [1, 2], retryScaleMs: 1000 };
    const wait0 = computeRetryWaitMs(config, 0, () => 0);
    expect(wait0).toBe(1000);
    const wait1 = computeRetryWaitMs(config, 1, () => 0.5);
    expect(wait1).toBe(2000 + 250);
  });
});
