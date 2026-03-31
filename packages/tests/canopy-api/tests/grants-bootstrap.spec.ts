import { randomUUID } from "node:crypto";
import { decode } from "cbor-x";
import { expectAPI as expect, test } from "./fixtures/auth";
import { sequencingBackoff } from "./utils/arithmetic-backoff-poll";
import {
  assertCustodianProfileTransparentStatement,
  buildCompletedGrantBase64,
  completeBootstrapGrantWithReceipt,
  DEFAULT_ROOT_LOG_ID,
  mintBootstrapGrantPlaywright,
  shouldSkipSequencingPoll,
} from "./utils/bootstrap-grant-flow";
import { decodeEntryIdHex } from "./utils/entry-id-e2e";
import { skipOrThrowIfBootstrapMintUnconfigured } from "./utils/bootstrap-e2e-guard";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";

/**
 * End-to-end against a **deployed** worker: Custodian-backed bootstrap mint and
 * register-grant on the **bootstrap branch** (uninitialized root log).
 *
 * Requires: `CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`, `SEQUENCING_QUEUE`,
 * `R2_MMRS`, `bootstrapEnv` + `queueEnv` in the worker, and **no** first massif tile
 * for the target log in MMRS storage (otherwise register-grant expects receipt-based
 * auth and this test will not get 303).
 *
 * The **sequencing → receipt** test needs **forestrie-ingress** (or equivalent) running
 * against the same env so enqueued grants are sequenced and MMRS is written. Set
 * **`E2E_SKIP_SEQUENCING_POLL=1`** to skip only that test when api-dev is up without ingress.
 */
test.describe("Bootstrap grant e2e — mint and register-grant", () => {
  test.describe.configure({ mode: "serial" });

  test("POST /api/grants/bootstrap returns 201 and Custodian-profile transparent statement", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
      data: JSON.stringify({ rootLogId: DEFAULT_ROOT_LOG_ID }),
      headers: { "content-type": "application/json" },
    });

    const problemMint = await reportProblemDetails(mintRes, testInfo);
    if (
      skipOrThrowIfBootstrapMintUnconfigured(
        mintRes.status(),
        problemMint,
        testInfo,
      ) === "skip"
    ) {
      return;
    }
    expect(mintRes.status(), formatProblemDetailsMessage(problemMint)).toBe(
      201,
    );
    const body = (await mintRes.text()).trim();
    expect(body.length).toBeGreaterThan(0);
    expect(() =>
      assertCustodianProfileTransparentStatement(body),
    ).not.toThrow();
  });

  test("After bootstrap mint, POST /logs/{logId}/grants returns 303 See Other (enqueued)", async ({
    unauthorizedRequest,
  }, testInfo) => {
    // Fresh log so api-dev (MMRS already present for DEFAULT_ROOT_LOG_ID) still
    // hits the bootstrap branch; see AGENTS.md bootstrap e2e caveats.
    const logId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const minted = await mintBootstrapGrantPlaywright(
      unauthorizedRequest,
      logId,
      testInfo,
    );
    if (minted.skipped) return;

    const grantBase64 = minted.grantBase64;
    expect(() =>
      assertCustodianProfileTransparentStatement(grantBase64),
    ).not.toThrow();

    const registerRes = await unauthorizedRequest.post(
      `/logs/${logId}/grants`,
      {
        headers: {
          Authorization: `Forestrie-Grant ${grantBase64}`,
        },
        maxRedirects: 0,
      },
    );

    const problemReg = await reportProblemDetails(registerRes, testInfo);
    const regStatus = registerRes.status();
    let regHint = formatProblemDetailsMessage(problemReg) ?? "register-grant";
    if (regStatus !== 303) {
      regHint += `\nBody preview: ${await responseTextPreview(registerRes)}`;
      regHint +=
        "\nExpected 303 See Other when bootstrap branch accepts the grant (queue + bootstrapEnv + no first MMRS massif for logId).";
    }
    expect(regStatus, regHint).toBe(303);

    const location = registerRes.headers().location;
    expect(
      location,
      "303 must include Location for GET registration status (/logs/.../entries/{innerHex})",
    ).toBeTruthy();
    let absolute = location!;
    if (!absolute.startsWith("http")) {
      absolute = `${baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
    }
    const escapedLogId = logId.replace(/-/g, "\\-");
    expect(absolute).toMatch(
      new RegExp(`/logs/${escapedLogId}/entries/[0-9a-f]{64}$`, "i"),
    );
  });

  test("Bootstrap mint + register, poll sequencing, SCITT receipt, mmrIndex 0", async ({
    unauthorizedRequest,
  }, testInfo) => {
    if (shouldSkipSequencingPoll()) {
      testInfo.skip(
        true,
        "E2E_SKIP_SEQUENCING_POLL: skipping poll until SCITT receipt (e.g. api-dev without forestrie-ingress)",
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

    const { grantBase64, statusUrlAbsolute, entryIdHex, receiptRes } =
      await completeBootstrapGrantWithReceipt({
        unauthorizedRequest,
        logId,
        baseURL,
        grantBase64: minted.grantBase64,
        ladderMs: sequencingBackoff,
      });

    expect(receiptRes.status, "resolve-receipt returns CBOR receipt").toBe(200);
    const ct = receiptRes.headers["content-type"] ?? "";
    expect(ct, "SCITT receipt content type").toMatch(
      /application\/scitt-receipt\+cbor/i,
    );

    const receiptBytes = receiptRes.body;
    const decoded = decode(receiptBytes) as unknown;
    expect(Array.isArray(decoded), "receipt is COSE Sign1 array").toBe(true);
    expect((decoded as unknown[]).length).toBe(4);
    const sign1 = decoded as unknown[];
    expect(
      sign1[0] instanceof Uint8Array,
      "Sign1[0] protected header bstr",
    ).toBe(true);
    const payload = sign1[2];
    expect(
      payload === null ||
        payload === undefined ||
        payload instanceof Uint8Array,
      "Sign1[2] must be nil (detached) or payload bstr",
    ).toBe(true);
    expect(sign1[3] instanceof Uint8Array, "Sign1[3] signature bstr").toBe(
      true,
    );

    const { mmrIndex } = decodeEntryIdHex(entryIdHex);
    expect(
      mmrIndex,
      "random logId implies first leaf only; non-zero means concurrent " +
        "bootstrap on the same log (parallel tests reusing logId)",
    ).toBe(0n);

    const completedB64 = buildCompletedGrantBase64(
      grantBase64,
      receiptBytes,
      entryIdHex,
    );

    const secondRegisterRes = await unauthorizedRequest.post(
      `/logs/${logId}/grants`,
      {
        headers: { Authorization: `Forestrie-Grant ${completedB64}` },
        maxRedirects: 0,
      },
    );
    const problemSecond = await reportProblemDetails(
      secondRegisterRes,
      testInfo,
    );
    expect(
      secondRegisterRes.status(),
      formatProblemDetailsMessage(problemSecond) ??
        (await responseTextPreview(secondRegisterRes)),
    ).toBe(303);
    const locSecond = secondRegisterRes.headers().location;
    expect(
      locSecond,
      "second register-grant 303 must include Location",
    ).toBeTruthy();
    let absoluteSecond = locSecond!;
    if (!absoluteSecond.startsWith("http")) {
      absoluteSecond = `${baseURL}${absoluteSecond.startsWith("/") ? "" : "/"}${absoluteSecond}`;
    }
    const innerMatch = statusUrlAbsolute.match(/\/entries\/([0-9a-f]{64})/i);
    expect(innerMatch, "status URL must contain inner hex").toBeTruthy();
    const innerHex = innerMatch![1]!.toLowerCase();
    expect(absoluteSecond.toLowerCase()).toContain(`/entries/${innerHex}`);
  });
});
