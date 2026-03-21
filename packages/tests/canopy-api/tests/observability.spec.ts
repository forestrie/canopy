import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";

/**
 * Operational visibility: liveness and service discovery.
 *
 * Canopy-api does not expose a Prometheus `/metrics` scrape endpoint on the Worker today.
 * When one is added, assert GET /metrics here (e.g. text/plain + 200).
 */
test.describe("Observability", () => {
  test("GET /api/health returns JSON liveness", async ({
    unauthorizedRequest,
  }) => {
    const response = await unauthorizedRequest.get("/api/health");
    const problemDetails = await reportProblemDetails(response, test.info());
    expect(response.status(), formatProblemDetailsMessage(problemDetails)).toBe(
      200,
    );

    const data = await response.json();
    expect(data.status).toBe("healthy");
    expect(data.canopyId).toBeTruthy();
    expect(data.apiVersion).toBeTruthy();
  });

  test("GET /.well-known/scitt-configuration returns SCRAPI discovery JSON", async ({
    unauthorizedRequest,
  }) => {
    const response = await unauthorizedRequest.get(
      "/.well-known/scitt-configuration",
    );

    const problemDetails = await reportProblemDetails(response, test.info());
    expect(response.status(), formatProblemDetailsMessage(problemDetails)).toBe(
      200,
    );
    expect(response.headers()["content-type"]).toContain("application/json");

    const config = await response.json();
    expect(config.serviceId).toBeTruthy();
    expect(config.scrapiVersion).toBeTruthy();
    expect(config.baseUrl).toBeTruthy();
  });
});
