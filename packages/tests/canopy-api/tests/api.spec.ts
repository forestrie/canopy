import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";

test.describe("Canopy API", () => {
  test("returns health status", async ({ unauthorizedRequest }) => {
    const response = await unauthorizedRequest.get("/api/health");
    const problemDetails = await reportProblemDetails(response, test.info());
    expect(response.status(), formatProblemDetailsMessage(problemDetails)).toBe(
      200,
    );

    const data = await response.json();
    expect(data.status).toBe("healthy");
    expect(data.canopyId).toBeTruthy();
  });

  test("returns SCITT configuration", async ({ unauthorizedRequest }) => {
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

  test("registers a COSE statement", async ({
    authorizedRequest,
    authToken,
  }) => {
    test.skip(
      false,
      "TODO: enable once /logs endpoint accepts COSE payloads in test environments",
    );

    const mockCoseSign1 = Uint8Array.from([
      0x84, // CBOR array of 4 elements
      0x40, // protected headers (empty bstr)
      0xa0, // unprotected headers (empty map)
      0x45,
      0x48,
      0x65,
      0x6c,
      0x6c,
      0x6f, // payload "Hello"
      0x40, // signature (empty bstr)
    ]);

    // Use a valid but fixed UUID as the logId
    const logId = "123e4567-e89b-12d3-a456-426614174000";

    const response = await authorizedRequest.post(`/logs/${logId}/entries`, {
      data: Buffer.from(mockCoseSign1),
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        authorization: `Bearer ${authToken}`,
      },
      maxRedirects: 0, // because register statement *always* returns 303 if its successful
    });

    const problemDetails = await reportProblemDetails(response, test.info());
    expect(response.status(), formatProblemDetailsMessage(problemDetails)).toBe(
      303,
    );
    const location = response.headers()["location"];
    expect(location).toBeTruthy();
    expect(location).toMatch(
      new RegExp(`/logs/${logId.replace(/[-]/g, "\\-")}/entries/[a-f0-9]{64}$`),
    );
  });
});
