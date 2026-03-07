import cbor from "cbor";
import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

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

  test("registers a COSE statement (grant flow)", async ({
    unauthorizedRequest,
  }) => {
    const logId = "123e4567-e89b-12d3-a456-426614174000";
    const signerKid = new Uint8Array([0x01, 0x02, 0x03]);

    const grantBody = {
      logId: uuidToBytes(logId),
      ownerLogId: uuidToBytes("660e8400-e29b-41d4-a716-446655440001"),
      grantFlags: new Uint8Array(8),
      grantData: new Uint8Array(0),
      signer: signerKid,
      kind: new Uint8Array([0]),
    };
    const grantResponse = await unauthorizedRequest.post(
      `/logs/${logId}/grants`,
      {
        data: Buffer.from(cbor.encode(grantBody)),
        headers: { "content-type": "application/cbor" },
      },
    );
    if (grantResponse.status() === 404) {
      test.skip(true, "Remote API does not yet expose POST /logs/{id}/grants");
    }
    const problemDetailsGrant = await reportProblemDetails(
      grantResponse,
      test.info(),
    );
    expect(
      grantResponse.status(),
      formatProblemDetailsMessage(problemDetailsGrant),
    ).toBe(201);
    const grantLocation = grantResponse.headers()["location"];
    expect(grantLocation).toBeTruthy();
    expect(grantLocation).toMatch(/^\/attestor\/[0-9a-f]{64}\.cbor$/);

    const protectedHeader = cbor.encode(new Map([[4, signerKid]]));
    const mockCoseSign1 = cbor.encode([
      protectedHeader,
      new Map(),
      Buffer.from("Hello"),
      new Uint8Array(64),
    ]);

    const response = await unauthorizedRequest.post(`/logs/${logId}/entries`, {
      data: Buffer.from(mockCoseSign1),
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        "X-Grant-Location": grantLocation!,
      },
      maxRedirects: 0,
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
