import { decode as decodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

// Mock x402 parsing and facilitator behaviour so we can focus on the
// HTTP-level behaviour of the worker without depending on real
// signatures or network calls.
vi.mock("../src/scrapi/x402", async () => {
  const actual =
    await vi.importActual<typeof import("../src/scrapi/x402")>(
      "../src/scrapi/x402",
    );

  return {
    ...actual,
    parsePaymentHeader: vi.fn(() => ({
      ok: true as const,
      value: {
        // Standard x402 exact scheme payload shape
        payerAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        scheme: "exact" as const,
        network: "eip155:84532",
        payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
        amount: "1000",
        payload: {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:84532",
          payload: {
            signature: "0x" + "ab".repeat(65),
            authorization: {
              from: "0x1111111111111111111111111111111111111111",
              to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
              value: "1000",
              validAfter: "0",
              validBefore: String(Math.floor(Date.now() / 1000) + 300),
              nonce: "0x" + "00".repeat(32),
            },
          },
        },
      },
    })),
  };
});

vi.mock("../src/scrapi/x402-facilitator", async () => {
  const actual = await vi.importActual<
    typeof import("../src/scrapi/x402-facilitator")
  >("../src/scrapi/x402-facilitator");

  return {
    ...actual,
    verifyPayment: vi.fn(async () => ({
      ok: false as const,
      error: "forced facilitator failure",
    })),
  };
});

vi.mock("../src/scrapi/register-signed-statement", () => ({
  registerSignedStatement: vi.fn(
    async () =>
      new Response(null, {
        status: 303,
        headers: {
          Location:
            "http://localhost/logs/de305d54-75b4-431b-adb2-eb6b9e546014/entries/" +
            "0123456789abcdef".repeat(4),
        },
      }),
  ),
}));

import worker from "../src/index";
import type { Env } from "../src/index";
import { verifyPayment } from "../src/scrapi/x402-facilitator";

const baseEnv = env as unknown as Env;

describe("x402 verify-and-settle mode", () => {
  it("returns 500 when verify-and-settle is enabled but facilitator URL is missing", async () => {
    const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";

    const misconfiguredEnv: Env = {
      ...(baseEnv as any),
      X402_MODE: "verify-and-settle",
      X402_FACILITATOR_URL: undefined as any,
    };

    const request = new Request(`http://localhost/logs/${logId}/entries`, {
      method: "POST",
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        "X-PAYMENT": "ZHVtbXk=", // base64 "dummy"
      },
      body: new Uint8Array([0x80]),
    });

    const response = await worker.fetch(
      request,
      misconfiguredEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);

    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeCbor(bodyBytes) as any;
    expect(decoded).toMatchObject({
      status: 500,
      title: "Internal Server Error",
    });
    expect(String(decoded.detail || "")).toContain(
      "requires X402_FACILITATOR_URL to be configured",
    );
  });

  it("returns 402 when facilitator verification fails in verify-and-settle mode", async () => {
    const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";

    const settleEnv: Env = {
      ...(baseEnv as any),
      X402_MODE: "verify-and-settle",
      // Provide a dummy facilitator URL so we exercise the
      // verifyAuthorizationForRegister path instead of the
      // misconfiguration guard.
      X402_FACILITATOR_URL: "https://example.invalid/facilitator",
    };

    const request = new Request(`http://localhost/logs/${logId}/entries`, {
      method: "POST",
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        "X-PAYMENT": "ZHVtbXktdmFsaWQtaGVhZGVy", // base64 "dummy-valid-header"
      },
      body: new Uint8Array([0x80]),
    });

    const response = await worker.fetch(
      request,
      settleEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(402);

    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeCbor(bodyBytes) as any;
    expect(decoded).toMatchObject({
      status: 402,
      title: "Payment Required",
    });
    expect(String(decoded.detail || "")).toContain(
      "x402 verification failed: forced facilitator failure",
    );
  });

  it("allows registration to proceed when facilitator verification succeeds", async () => {
    const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";

    const settleEnv: Env = {
      ...(baseEnv as any),
      X402_MODE: "verify-and-settle",
      X402_FACILITATOR_URL: "https://example.invalid/facilitator",
    };

    // For this test, override the default failing mock and force a
    // successful facilitator verification.
    vi.mocked(verifyPayment).mockResolvedValueOnce({
      ok: true,
      authId: "auth:happy-path",
      isValid: true,
    });

    const request = new Request(`http://localhost/logs/${logId}/entries`, {
      method: "POST",
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        "X-PAYMENT": "ZHVtbXktdmFsaWQtaGVhZGVy", // base64 "dummy-valid-header"
      },
      body: new Uint8Array([0x80]),
    });

    const response = await worker.fetch(
      request,
      settleEnv,
      {} as ExecutionContext,
    );

    // We mocked registerSignedStatement to return 303 with a Location
    // header, so a successful facilitator check should allow that
    // response to propagate.
    expect(response.status).toBe(303);
    const location = response.headers.get("Location");
    expect(location).not.toBeNull();
    expect(location).toMatch(
      /\/logs\/de305d54-75b4-431b-adb2-eb6b9e546014\/entries\/[0-9a-f]{64}$/,
    );
  });
});
