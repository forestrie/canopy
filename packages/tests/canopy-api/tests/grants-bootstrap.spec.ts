import { randomUUID } from "node:crypto";
import { decode } from "cbor-x";
import { expectAPI as expect, test } from "./fixtures/auth";
import {
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  sequencingBackoff,
} from "./utils/arithmetic-backoff-poll";
import { postRegisterGrantExpect303 } from "./utils/bootstrap-grant-setup";
import { skipOrThrowIfBootstrapMintUnconfigured } from "./utils/bootstrap-e2e-guard";
import { attachReceiptAndIdtimestampToTransparentStatement } from "../../../apps/canopy-api/src/scrapi/attach-scitt-transparent-statement-receipt.js";
import {
  decodeEntryIdHex,
  entryIdHexToIdtimestampBe8,
} from "./utils/entry-id-e2e";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";

/** Plan 0014 / `transparent-statement.ts`: full grant v0 CBOR in unprotected header. */
const HEADER_FORESTRIE_GRANT_V0 = -65538;

function toHeaderMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (typeof raw === "object" && raw !== null && !(raw instanceof Uint8Array)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

/**
 * Assert base64 body matches Custodian Forestrie-Grant wire: COSE Sign1, 32-byte
 * digest payload, unprotected -65538 carries grant v0 CBOR.
 */
function assertCustodianProfileTransparentStatement(base64: string): void {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  const sign1 = decode(bytes) as unknown;
  if (!Array.isArray(sign1) || sign1.length !== 4) {
    throw new Error("Expected untagged COSE Sign1 (CBOR array of 4 elements)");
  }
  const payload = sign1[2];
  if (!(payload instanceof Uint8Array) || payload.length !== 32) {
    throw new Error(
      "Expected COSE payload to be 32-byte SHA-256 digest (Custodian profile)",
    );
  }
  const sig = sign1[3];
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new Error(
      "Expected COSE ES256 signature bstr to be 64-byte IEEE P1363 (not KMS DER)",
    );
  }
  const unprotected = toHeaderMap(sign1[1]);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      `Expected unprotected header ${HEADER_FORESTRIE_GRANT_V0} (grant v0 CBOR bytes)`,
    );
  }
}

const DEFAULT_ROOT_LOG_ID = "123e4567-e89b-12d3-a456-426614174000";

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

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

    const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
      data: JSON.stringify({ rootLogId: logId }),
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
    const grantBase64 = (await mintRes.text()).trim();
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
    if (
      process.env.E2E_SKIP_SEQUENCING_POLL === "1" ||
      process.env.E2E_SKIP_SEQUENCING_POLL === "true"
    ) {
      testInfo.skip(
        true,
        "E2E_SKIP_SEQUENCING_POLL: skipping poll until SCITT receipt (e.g. api-dev without forestrie-ingress)",
      );
      return;
    }

    test.setTimeout(600_000);
    const logId = randomUUID();
    const baseURL = testInfo.project.use.baseURL ?? "";

    const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
      data: JSON.stringify({ rootLogId: logId }),
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
    const grantBase64 = (await mintRes.text()).trim();

    const { statusUrlAbsolute } = await postRegisterGrantExpect303(
      unauthorizedRequest,
      { logId, baseURL, grantBase64 },
    );

    const { receiptUrlAbsolute, entryIdHex } =
      await pollQueryRegistrationUntilReceiptRedirect({
        request: unauthorizedRequest,
        statusUrlAbsolute,
        baseURL,
        ladderMs: sequencingBackoff,
        maxWaitMs: 180_000,
      });

    const receiptRes = await pollResolveReceiptUntil200({
      request: unauthorizedRequest,
      receiptUrlAbsolute,
      ladderMs: sequencingBackoff,
      maxWaitMs: 420_000,
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
    // MMRIVER peak receipts marshal with a detached payload (nil in Sign1[2]);
    // see go-merklelog massifs.signEmptyPeakReceipt.
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
      mmrIndex < 8n,
      "bootstrap grant should map to a small MMR index for a fresh log",
    ).toBe(true);

    const grantBytes = base64ToBytes(grantBase64);
    const idtimestampBe8 = entryIdHexToIdtimestampBe8(entryIdHex);
    const completedBytes = attachReceiptAndIdtimestampToTransparentStatement(
      grantBytes,
      receiptBytes,
      idtimestampBe8,
    );
    const completedB64 = bytesToForestrieGrantBase64(completedBytes);

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
