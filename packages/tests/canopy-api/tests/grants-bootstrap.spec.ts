import { decode } from "cbor-x";
import { expectAPI as expect, test } from "./fixtures/auth";
import { skipOrThrowIfBootstrapMintUnconfigured } from "./utils/bootstrap-e2e-guard";
import {
  formatProblemDetailsMessage,
  reportProblemDetails,
  responseTextPreview,
} from "./utils/problem-details";

/** Plan 0014 / `transparent-statement.ts`: full grant v0 CBOR in unprotected header. */
const HEADER_FORESTRIE_GRANT_V0 = -65538;

function toHeaderMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (
    typeof raw === "object" &&
    raw !== null &&
    !(raw instanceof Uint8Array)
  ) {
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
  const unprotected = toHeaderMap(sign1[1]);
  const embedded = unprotected.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error(
      `Expected unprotected header ${HEADER_FORESTRIE_GRANT_V0} (grant v0 CBOR bytes)`,
    );
  }
}

const DEFAULT_ROOT_LOG_ID = "123e4567-e89b-12d3-a456-426614174000";

/**
 * End-to-end against a **deployed** worker: Custodian-backed bootstrap mint and
 * register-grant on the **bootstrap branch** (uninitialized root log).
 *
 * Requires: `CUSTODIAN_URL`, `CUSTODIAN_BOOTSTRAP_APP_TOKEN`, `SEQUENCING_QUEUE`,
 * `bootstrapEnv` + `queueEnv` in the worker, and Univocity reachable for the target
 * log such that the log is **not** initialized (otherwise register-grant expects
 * receipt-based auth and this test will not get 303).
 */
test.describe("Bootstrap grant e2e — mint and register-grant", () => {
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
    expect(() => assertCustodianProfileTransparentStatement(body)).not.toThrow();
  });

  test("After bootstrap mint, POST /logs/{logId}/grants returns 303 See Other (enqueued)", async ({
    unauthorizedRequest,
  }, testInfo) => {
    const logId = DEFAULT_ROOT_LOG_ID;
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

    const registerRes = await unauthorizedRequest.post(`/logs/${logId}/grants`, {
      headers: {
        Authorization: `Forestrie-Grant ${grantBase64}`,
      },
      maxRedirects: 0,
    });

    const problemReg = await reportProblemDetails(registerRes, testInfo);
    const regStatus = registerRes.status();
    let regHint = formatProblemDetailsMessage(problemReg) ?? "register-grant";
    if (regStatus !== 303) {
      regHint += `\nBody preview: ${await responseTextPreview(registerRes)}`;
      regHint +=
        "\nExpected 303 See Other when bootstrap branch accepts the grant (queue + bootstrapEnv + uninitialized root log in Univocity).";
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
      new RegExp(
        `/logs/${escapedLogId}/entries/[0-9a-f]{64}$`,
        "i",
      ),
    );
  });
});
