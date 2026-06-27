import { describe, expect, it } from "vitest";
import { parseCloudflaredPublicUrl } from "./mode-c-webhook-tunnel.js";

describe("parseCloudflaredPublicUrl", () => {
  it("extracts trycloudflare origin from cloudflared log line", () => {
    const line =
      "INF Thank you for trying Cloudflare Tunnel. Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): https://abc-def-ghi.trycloudflare.com";
    expect(parseCloudflaredPublicUrl(line)).toBe(
      "https://abc-def-ghi.trycloudflare.com",
    );
  });

  it("returns null when no tunnel URL is present", () => {
    expect(parseCloudflaredPublicUrl("cloudflared starting")).toBeNull();
  });
});

describe("modeCAllowPullFallback", () => {
  it("is false unless E2E_MODE_C_ALLOW_PULL_FALLBACK=1", async () => {
    const prev = process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK;
    delete process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK;
    const { modeCAllowPullFallback } = await import("./mode-c-e2e-env.js");
    expect(modeCAllowPullFallback()).toBe(false);
    process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK = "1";
    expect(modeCAllowPullFallback()).toBe(true);
    if (prev === undefined) delete process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK;
    else process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK = prev;
  });
});
