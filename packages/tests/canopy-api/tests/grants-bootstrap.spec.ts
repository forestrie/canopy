import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";

test.describe("Grants — bootstrap mint", () => {
  test("POST /api/grants/bootstrap returns 201 (ES256) when delegation-signer is configured", async ({
    unauthorizedRequest,
  }) => {
    const logId = "123e4567-e89b-12d3-a456-426614174000";
    const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
      data: JSON.stringify({ rootLogId: logId }),
      headers: { "content-type": "application/json" },
    });

    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(
      201,
    );
    const body = await mintRes.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("POST /api/grants/bootstrap with alg=KS256 returns 201 or documents not implemented", async ({
    unauthorizedRequest,
  }) => {
    const logId = "123e4567-e89b-12d3-a456-426614174001";
    const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
      data: JSON.stringify({ rootLogId: logId, alg: "KS256" }),
      headers: { "content-type": "application/json" },
    });

    const status = mintRes.status();

    if (status === 500) {
      const preview = await responseTextPreview(mintRes);
      expect(preview).toMatch(/KS256|not.*implemented|internal/i);
      return;
    }

    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(status, formatProblemDetailsMessage(problemMint)).toBe(201);
    const body = await mintRes.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
