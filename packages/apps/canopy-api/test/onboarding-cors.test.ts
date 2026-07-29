/**
 * CORS posture for browser-direct onboarding (plan-2607-45 slice 01B).
 *
 * The console (Safe 1x1 Mode D /onboard wizard) talks to canopy directly
 * from the browser: `application/cbor` bodies on onboarding create/redeem
 * and genesis, `Authorization` carrying the onboard token on genesis. The
 * global posture (canopy#197 precedent) already admits these; this suite
 * locks it so a header regression cannot silently break the wizard.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;
const testCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
} as ExecutionContext;

const CONSOLE_ORIGIN = "https://mandate-prod.pages.dev";

/** The exact cross-origin requests the /onboard wizard issues. */
const WIZARD_ROUTES: Array<{ path: string; method: string }> = [
  { path: "/api/onboarding/requests", method: "POST" },
  { path: "/api/onboarding/requests/some-request-id", method: "GET" },
  { path: "/api/onboarding/requests/some-request-id/redeem", method: "POST" },
  { path: "/api/forest/0011223344556677/genesis", method: "POST" },
];

function preflight(path: string, method: string): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "OPTIONS",
      headers: {
        Origin: CONSOLE_ORIGIN,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": "content-type, authorization",
      },
    }),
    poolEnv,
    testCtx,
  );
}

describe("browser-direct onboarding CORS", () => {
  it("preflight admits application/cbor + Authorization on every wizard route", async () => {
    for (const { path, method } of WIZARD_ROUTES) {
      const res = await preflight(path, method);
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const allowHeaders = (
        res.headers.get("Access-Control-Allow-Headers") ?? ""
      ).toLowerCase();
      expect(allowHeaders).toContain("content-type");
      expect(allowHeaders).toContain("authorization");
      const allowMethods = res.headers.get("Access-Control-Allow-Methods");
      expect(allowMethods).toContain(method);
    }
  });

  it("onboarding responses carry CORS headers (error paths included)", async () => {
    // A create with a wrong content type fails early — the browser must
    // still be able to read the problem response cross-origin.
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: {
          Origin: CONSOLE_ORIGIN,
          "Content-Type": "text/plain",
        },
        body: "nope",
      }),
      poolEnv,
      testCtx,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
