import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";
import {
  responseTextPreview,
  skipIfBootstrapMintUnavailable,
} from "./utils/bootstrap-availability";

test.describe("Grants — bootstrap mint", () => {
  test("POST /api/grants/bootstrap returns 201 (ES256) when delegation-signer is configured", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const logId = "123e4567-e89b-12d3-a456-426614174000";
    const mintRes = await unauthorizedRequest.post(
      "/api/grants/bootstrap",
      {
        data: JSON.stringify({ rootLogId: logId }),
        headers: { "content-type": "application/json" },
      },
    );

    skipIfBootstrapMintUnavailable(
      mintRes.status(),
      testInfo.project.name,
    );

    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(201);
    const body = await mintRes.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("POST /api/grants/bootstrap with alg=KS256 returns 201 or documents not implemented", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const logId = "123e4567-e89b-12d3-a456-426614174001";
    const mintRes = await unauthorizedRequest.post(
      "/api/grants/bootstrap",
      {
        data: JSON.stringify({ rootLogId: logId, alg: "KS256" }),
        headers: { "content-type": "application/json" },
      },
    );

    const status = mintRes.status();
    const localFull =
      testInfo.project.name === "local" &&
      process.env.CANOPY_E2E_LIGHT_STACK !== "true";
    if (localFull) {
      expect(
        status === 201 || status === 500,
        `Local full-stack: KS256 mint expected 201 or 500 (not implemented), got ${status}`,
      ).toBe(true);
    } else {
      skipIfBootstrapMintUnavailable(status, testInfo.project.name);
    }

    const preview = await responseTextPreview(mintRes);

    if (status === 500) {
      // canopy-api returns 500 while KS256 bootstrap grantData is unimplemented
      expect(preview).toMatch(/KS256|not.*implemented|internal/i);
      return;
    }

    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(status, formatProblemDetailsMessage(problemMint)).toBe(201);
    expect(preview.length).toBeGreaterThan(0);
  });
});
