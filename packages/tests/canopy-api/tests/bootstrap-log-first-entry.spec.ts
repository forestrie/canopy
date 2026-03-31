import { randomUUID } from "node:crypto";
import { expectAPI as expect, test } from "./fixtures/auth";
import { sequencingBackoff } from "./utils/arithmetic-backoff-poll";
import {
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  mintBootstrapGrantPlaywright,
  shouldSkipSequencingPoll,
} from "./utils/bootstrap-grant-flow";
import {
  custodianBootstrapSignEnv,
  e2eFirstStatementPayload,
  postCustodianBootstrapSignPayloadBytes,
} from "./utils/custodian-bootstrap-sign";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * First transparency **statement** on a freshly bootstrapped root log: completed
 * Forestrie-Grant (receipt + idtimestamp) plus Custodian `:bootstrap` COSE Sign1 body.
 *
 * Needs the same sequencing + MMRS setup as `grants-bootstrap` poll test, plus
 * **Custodian reachable from the runner** (`CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`)
 * to mint the statement signature.
 */
test.describe("Bootstrap log e2e — first signed entry", () => {
  test.describe.configure({ mode: "serial" });

  test("POST /logs/{logId}/entries returns 303 with content-hash Location", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (shouldSkipSequencingPoll()) {
      testInfo.skip(
        true,
        "E2E_SKIP_SEQUENCING_POLL: skip until SCITT / ingress (same as bootstrap receipt test)",
      );
      return;
    }

    if (!custodianBootstrapSignEnv()) {
      testInfo.skip(
        true,
        "CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN must be set in repo-root .env for Custodian statement signing",
      );
      return;
    }

    test.setTimeout(600_000);
    const logId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const minted = await mintBootstrapGrantPlaywright(
      unauthorizedRequest,
      logId,
      testInfo,
    );
    if (minted.skipped) return;

    const { grantBase64, entryIdHex, receiptRes } =
      await completeBootstrapGrantWithReceipt({
        unauthorizedRequest,
        logId,
        baseURL,
        grantBase64: minted.grantBase64,
        ladderMs: sequencingBackoff,
      });

    expect(receiptRes.status).toBe(200);

    const completedGrantB64 = buildCompletedGrantBase64(
      grantBase64,
      receiptRes.body,
      entryIdHex,
    );

    const statementPayload = e2eFirstStatementPayload();
    const sign1Bytes =
      await postCustodianBootstrapSignPayloadBytes(statementPayload);

    const expectedHash = await sha256Hex(sign1Bytes);
    const entriesRes = await unauthorizedRequest.post(
      `/logs/${logId}/entries`,
      {
        headers: {
          Authorization: `Forestrie-Grant ${completedGrantB64}`,
          "content-type": 'application/cose; cose-type="cose-sign1"',
        },
        data: Buffer.from(sign1Bytes),
        maxRedirects: 0,
      },
    );

    const problem = await reportProblemDetails(entriesRes, testInfo);
    const hint =
      formatProblemDetailsMessage(problem) ??
      (await responseTextPreview(entriesRes));
    expect(entriesRes.status(), hint).toBe(303);

    const loc = entriesRes.headers().location;
    expect(loc, "303 must include Location with content hash").toBeTruthy();
    let absolute = loc!;
    if (!absolute.startsWith("http")) {
      absolute = `${baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
    }
    expect(absolute.toLowerCase()).toContain(
      `/logs/${logId}/entries/${expectedHash}`.toLowerCase(),
    );
  });
});
