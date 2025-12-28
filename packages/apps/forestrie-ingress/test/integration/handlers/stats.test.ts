import { describe, expect, it } from "vitest";
import worker from "../../../src/index";
import type { QueueStats } from "@canopy/forestrie-ingress-types";
import { testEnv, createRequest } from "./fixture";

describe("/queue/stats", () => {
  it("GET returns JSON stats", async () => {
    const request = createRequest("/queue/stats");

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");

    const stats = (await response.json()) as QueueStats;
    expect(stats).toHaveProperty("pending");
    expect(stats).toHaveProperty("deadLetters");
    expect(stats).toHaveProperty("activePollers");
    expect(stats).toHaveProperty("pollerLimitReached");
  });

  it("POST returns 405 Method Not Allowed", async () => {
    const request = createRequest("/queue/stats", {
      method: "POST",
      body: {},
    });

    const response = await worker.fetch(
      request,
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(405);
  });
});
