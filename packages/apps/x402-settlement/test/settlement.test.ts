import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Cast env to the proper type (cloudflare:test ProvidedEnv doesn't include all bindings)
const typedEnv = env as Env;

describe("x402-settlement worker", () => {
  it("responds to health check", async () => {
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("canopyId");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("http://localhost/unknown");
    expect(response.status).toBe(404);
  });
});

// FOR-79. CDP credentials never reached this worker: the CI step that pushed
// them ran at the repo root with no wrangler config and hid the error behind
// `|| true`. The failure mode is silent — /verify and /settle 500, and the
// queue consumer returns permanent:true, which blocks the payer's auth after
// 10 failures. `hasCdpCredentials` on /health is the deploy-time probe that
// makes the condition observable, so it must tell the truth.
describe("CDP credential reporting (FOR-79)", () => {
  it("/health hasCdpCredentials reflects credential absence", async () => {
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);

    const data = (await response.json()) as { hasCdpCredentials: boolean };
    expect(data).toHaveProperty("hasCdpCredentials");
    expect(typeof data.hasCdpCredentials).toBe("boolean");

    // The test env supplies no CDP secrets, so this must be false. A `true`
    // here would mean the probe cannot distinguish configured from not —
    // exactly the blind spot that let the broken secret push go unnoticed.
    expect(data.hasCdpCredentials).toBe(false);
  });

  it("/verify fails closed with 'facilitator not configured' when creds absent", async () => {
    const response = await SELF.fetch("http://localhost/verify", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);

    const data = (await response.json()) as {
      isValid: boolean;
      invalidReason: string;
    };
    expect(data.isValid).toBe(false);
    expect(data.invalidReason).toBe("facilitator not configured");
  });

  it("/settle fails closed with 'facilitator not configured' when creds absent", async () => {
    const response = await SELF.fetch("http://localhost/settle", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);

    const data = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(data.success).toBe(false);
    expect(data.error).toBe("facilitator not configured");
  });
});

describe("X402SettlementDO", () => {
  it("can be instantiated", async () => {
    const doId = typedEnv.X402_SETTLEMENT_DO.idFromName("shard-0");
    const stub = typedEnv.X402_SETTLEMENT_DO.get(doId);

    // The DO should exist and be callable
    expect(stub).toBeDefined();
  });

  it("returns null for unknown auth", async () => {
    const doId = typedEnv.X402_SETTLEMENT_DO.idFromName("shard-0");
    const stub = typedEnv.X402_SETTLEMENT_DO.get(doId);

    const result = await stub.getAuthInfo("nonexistent-auth-id");
    expect(result).toBeNull();
  });
});
