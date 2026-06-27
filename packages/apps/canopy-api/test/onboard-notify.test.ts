import { describe, expect, it, vi, afterEach } from "vitest";
import { emitOnboardWebhook } from "../src/onboarding/onboard-notify.js";

describe("onboard notify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs webhook payload when secret configured", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await emitOnboardWebhook(
      {
        ONBOARD_REQUEST_WEBHOOK_URL: "https://hooks.example/notify",
        ONBOARD_REQUEST_WEBHOOK_SECRET: "test-secret",
      },
      "onboard.request.created",
      { requestId: "req-1", label: "fork" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Forestrie-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.event).toBe("onboard.request.created");
    expect(body.requestId).toBe("req-1");
    expect(body.redeemCode).toBeUndefined();
  });
});
