import cbor from "cbor";
import { expectAPI as expect, test } from "./fixtures/auth";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
} from "./utils/problem-details";
import {
  skipIfBootstrapMintUnavailable,
  skipIfRegisterGrantUnavailable,
} from "./utils/bootstrap-availability";
import {
  buildCompletedGrant,
  statementKidBytesFromForestrieGrantBase64,
} from "./utils/grant-completion";
import { pollUntilReceiptUrl } from "./utils/grant-flow-poll";

/**
 * Grant lifecycle after bootstrap mint: register-grant, poll, receipt, register-statement.
 * Depends on sequencing queue + bootstrap/univocity env for first grant on a log.
 */
test.describe("Grants — register and statement auth", () => {
  test("Forestrie-Grant flow: mint, register, poll, resolve, POST /entries", async ({
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
    skipIfBootstrapMintUnavailable(
      mintRes.status(),
      testInfo.project.name,
    );

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
    skipIfRegisterGrantUnavailable(
      registerRes.status(),
      baseURL,
      testInfo.project.name,
    );

    if (registerRes.status() === 503) {
      test.skip(
        true,
        "Sequencing DO not reachable in local wrangler dev (grant enqueued only when forestrie-ingress DO connects).",
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

    const receiptUrl = await pollUntilReceiptUrl(
      unauthorizedRequest,
      statusUrl!,
      baseURL,
    );
    if (!receiptUrl) {
      test.skip(
        true,
        "Poll timeout (queue not processing grants, or status URL unreachable).",
      );
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

    const signerKid = statementKidBytesFromForestrieGrantBase64(completedBase64);
    const mockCoseSign1 = cbor.encode([
      cbor.encode(new Map([[4, Buffer.from(signerKid)]])),
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
