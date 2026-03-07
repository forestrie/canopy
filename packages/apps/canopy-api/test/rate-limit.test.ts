/**
 * Rate limit unit tests (Plan 0001 Step 7).
 */

import { describe, expect, it } from "vitest";
import {
  checkGrantSignerRate,
  pruneState,
  DEFAULT_GRANT_SIGNER_RATE_CONFIG,
  type RateLimitState,
} from "../src/rate-limit";

const config = {
  ...DEFAULT_GRANT_SIGNER_RATE_CONFIG,
  windowMs: 3600000,
  spikeWindowMs: 60000,
  maxPerWindow: 5,
  maxPerSpike: 2,
};

describe("checkGrantSignerRate", () => {
  it("allows when under both limits", () => {
    const now = 1000000;
    const state: RateLimitState = { timestamps: [900000] };
    const { result, newState } = checkGrantSignerRate(now, state, config);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
    expect(newState.timestamps).toHaveLength(2);
    expect(newState.timestamps).toContain(now);
  });

  it("denies when over spike limit", () => {
    const now = 1000000;
    const state: RateLimitState = {
      timestamps: [999500, 999600],
    };
    const { result, newState } = checkGrantSignerRate(now, state, config);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeDefined();
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(newState.timestamps).toHaveLength(3);
  });

  it("denies when over window limit", () => {
    const now = 1000000;
    const state: RateLimitState = {
      timestamps: [999000, 999100, 999200, 999300, 999400],
    };
    const { result } = checkGrantSignerRate(now, state, config);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeDefined();
  });

  it("state updates correctly after allow", () => {
    const now = 1000000;
    const state: RateLimitState = { timestamps: [] };
    const { newState } = checkGrantSignerRate(now, state, config);
    expect(newState.timestamps).toEqual([now]);
    const { result: r2, newState: s2 } = checkGrantSignerRate(now + 1, newState, config);
    expect(r2.allowed).toBe(true);
    expect(s2.timestamps).toEqual([now, now + 1]);
  });

  it("spike boundary: exactly maxPerSpike at same moment is over limit", () => {
    const now = 1000000;
    const state: RateLimitState = {
      timestamps: [999500, 999600],
    };
    const { result } = checkGrantSignerRate(now, state, config);
    expect(result.allowed).toBe(false);
  });

  it("window boundary: exactly maxPerWindow is over limit", () => {
    const now = 1000000;
    const state: RateLimitState = {
      timestamps: [999000, 999100, 999200, 999300, 999400],
    };
    const { result } = checkGrantSignerRate(now, state, config);
    expect(result.allowed).toBe(false);
  });
});

describe("pruneState", () => {
  it("removes timestamps older than window", () => {
    const now = 1000000;
    const windowMs = 100000;
    const state: RateLimitState = {
      timestamps: [899000, 950000, 999000],
    };
    const pruned = pruneState(state, now, windowMs);
    expect(pruned.timestamps).toEqual([950000, 999000]);
  });
});
