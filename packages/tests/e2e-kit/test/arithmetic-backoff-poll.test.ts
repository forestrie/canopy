import { describe, expect, it } from "vitest";
import { sleepMs } from "../src/arithmetic-backoff-poll.js";

describe("sleepMs", () => {
  it("resolves after the requested delay", async () => {
    const start = Date.now();
    await sleepMs(25);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
