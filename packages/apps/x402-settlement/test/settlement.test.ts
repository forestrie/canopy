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

// FOR-79. `hasCdpCredentials` on /health is the deploy-time probe that makes an
// otherwise-silent credential gap observable (the queue consumer fails
// permanent:true and blocks the payer's auth after 10 failures), so it must
// tell the truth. The test env (wrangler.jsonc) points at the credential-free
// testnet facilitator https://x402.org/facilitator, so missing CDP creds must
// NOT be treated as a fatal "facilitator not configured" — that rejection only
// applies to the CDP facilitator. See cdp-jwt.test.ts for the gating predicate.
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

  // On the testnet facilitator the credential gate must NOT fire when creds are
  // absent. We assert only that the "facilitator not configured" short-circuit
  // did not happen — the actual upstream status (reached, or a 502 when the
  // sandbox has no network) is irrelevant and left unasserted to stay hermetic.
  it("/verify does not reject for missing creds on the testnet facilitator", async () => {
    const response = await SELF.fetch("http://localhost/verify", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const data = (await response.json()) as { invalidReason?: string };
    expect(data.invalidReason).not.toBe("facilitator not configured");
  });

  it("/settle does not reject for missing creds on the testnet facilitator", async () => {
    const response = await SELF.fetch("http://localhost/settle", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const data = (await response.json()) as { error?: string };
    expect(data.error).not.toBe("facilitator not configured");
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
