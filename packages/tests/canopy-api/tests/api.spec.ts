import { expectAPI as expect, test } from "./fixtures/auth";

/**
 * Cross-cutting HTTP behavior that is not tied to a single product feature.
 */
test.describe("Canopy API", () => {
  test("OPTIONS preflight returns 204 with CORS headers", async ({
    unauthorizedRequest,
  }) => {
    const response = await unauthorizedRequest.fetch("/api/health", {
      method: "OPTIONS",
    });
    expect(response.status()).toBe(204);
    expect(response.headers()["access-control-allow-origin"]).toBeTruthy();
  });
});
