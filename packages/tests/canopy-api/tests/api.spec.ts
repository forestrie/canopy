import cbor from "cbor";
import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";
import {
  buildCompletedGrant,
} from "./utils/grant-completion";

const POLL_MAX = 30;
const POLL_INTERVAL_MS = 500;

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

  test("bootstrap mint returns 201 (default ES256) when delegation-signer and ROOT_LOG_ID are configured", async ({
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
    if (mintRes.status() >= 500) {
      test.skip(
        true,
        "Bootstrap not configured (delegation-signer or ROOT_LOG_ID missing)",
      );
    }
    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(201);
    const body = await mintRes.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("bootstrap mint with alg=KS256 returns 201 when both algs supported", async ({
    unauthorizedRequest,
  }) => {
    const logId = "123e4567-e89b-12d3-a456-426614174001";
    const mintRes = await unauthorizedRequest.post(
      "/api/grants/bootstrap",
      {
        data: JSON.stringify({ rootLogId: logId, alg: "KS256" }),
        headers: { "content-type": "application/json" },
      },
    );
    if (mintRes.status() >= 500) {
      test.skip(
        true,
        "Bootstrap not configured or KS256 not supported",
      );
    }
    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(201);
    const body = await mintRes.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("grant flow: mint, register, poll, resolve, POST entry (Forestrie-Grant)", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const logId = "123e4567-e89b-12d3-a456-426614174000";
    const baseURL = testInfo.project.use.baseURL ?? "http://127.0.0.1:8789";

    const mintRes = await unauthorizedRequest.post(
      "/api/grants/bootstrap",
      {
        data: JSON.stringify({ rootLogId: logId }),
        headers: { "content-type": "application/json" },
      },
    );
    if (mintRes.status() >= 500) {
      test.skip(
        true,
        "Bootstrap not configured (delegation-signer or ROOT_LOG_ID missing)",
      );
    }
    const problemMint = await reportProblemDetails(mintRes, test.info());
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(201);
    const grantBase64 = await mintRes.text();

    const registerRes = await unauthorizedRequest.post(
      `/logs/${logId}/grants`,
      {
        headers: {
          Authorization: `Forestrie-Grant ${grantBase64}`,
        },
        maxRedirects: 0,
      },
    );
    if (registerRes.status() === 503) {
      test.skip(
        true,
        "Grant sequencing not configured (queue/DO missing)",
      );
    }
    if (registerRes.status() === 500 && baseURL.includes("127.0.0.1")) {
      test.skip(
        true,
        "Register failed (local DO RPC not supported between dev sessions)",
      );
    }
    const problemReg = await reportProblemDetails(registerRes, test.info());
    expect(registerRes.status(), formatProblemDetailsMessage(problemReg)).toBe(
      303,
    );
    let statusUrl = registerRes.headers()["location"];
    if (!statusUrl?.startsWith("http")) {
      statusUrl = `${baseURL}${statusUrl!.startsWith("/") ? "" : "/"}${statusUrl}`;
    }

    let receiptUrl: string | null = null;
    for (let i = 0; i < POLL_MAX; i++) {
      const pollRes = await unauthorizedRequest.get(statusUrl!, {
        maxRedirects: 0,
      });
      if (pollRes.status() === 303) {
        const loc = pollRes.headers()["location"];
        if (loc?.endsWith("/receipt")) {
          receiptUrl = loc.startsWith("http")
            ? loc
            : `${new URL(statusUrl!).origin}${loc.startsWith("/") ? loc : `/${loc}`}`;
          break;
        }
      }
      if (pollRes.status() >= 400) {
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!receiptUrl) {
      test.skip(true, "Poll timeout (queue may not be processing grants)");
    }

    const receiptRes = await unauthorizedRequest.get(receiptUrl!);
    const problemReceipt = await reportProblemDetails(receiptRes, test.info());
    expect(receiptRes.status(), formatProblemDetailsMessage(problemReceipt)).toBe(
      200,
    );
    const receiptBytes = receiptRes.body();
    const completedBase64 = buildCompletedGrant(
      grantBase64,
      receiptUrl!,
      new Uint8Array(receiptBytes),
    );

    const signerKid = new Uint8Array(32);
    const mockCoseSign1 = cbor.encode([
      cbor.encode(new Map([[4, signerKid]])),
      new Map(),
      Buffer.from("Hello"),
      new Uint8Array(64),
    ]);

    const entryRes = await unauthorizedRequest.post(`/logs/${logId}/entries`, {
      data: Buffer.from(mockCoseSign1),
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        Authorization: `Forestrie-Grant ${completedBase64}`,
      },
      maxRedirects: 0,
    });

    const problemEntry = await reportProblemDetails(entryRes, test.info());
    expect(entryRes.status(), formatProblemDetailsMessage(problemEntry)).toBe(
      303,
    );
    const location = entryRes.headers()["location"];
    expect(location).toBeTruthy();
    expect(location).toMatch(
      new RegExp(`/logs/${logId.replace(/[-]/g, "\\-")}/entries/[a-f0-9]{32}$`),
    );
  });
});
