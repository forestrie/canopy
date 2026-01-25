import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";

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

describe("X402SettlementDO", () => {
  it("can be instantiated", async () => {
    const doId = env.X402_SETTLEMENT_DO.idFromName("shard-0");
    const stub = env.X402_SETTLEMENT_DO.get(doId);

    // The DO should exist and be callable
    expect(stub).toBeDefined();
  });

  it("returns null for unknown auth", async () => {
    const doId = env.X402_SETTLEMENT_DO.idFromName("shard-0");
    const stub = env.X402_SETTLEMENT_DO.get(doId);

    const result = await stub.getAuthInfo("nonexistent-auth-id");
    expect(result).toBeNull();
  });
});
