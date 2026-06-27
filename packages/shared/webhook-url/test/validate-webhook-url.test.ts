/** Unit tests for {@link validateWebhookUrl} SSRF and protocol rules. */
import { describe, expect, it } from "vitest";
import { WebhookUrlValidationError, validateWebhookUrl } from "../src/index.js";

describe("validateWebhookUrl", () => {
  it("accepts https URLs with public hostnames", () => {
    expect(validateWebhookUrl("https://hooks.example.com/delegation")).toBe(
      "https://hooks.example.com/delegation",
    );
  });

  it("rejects http URLs when insecure local is not allowed", () => {
    expect(() => validateWebhookUrl("http://hooks.example.com/x")).toThrow(
      WebhookUrlValidationError,
    );
  });

  it("allows http localhost when allowInsecureLocal is true", () => {
    expect(
      validateWebhookUrl("http://localhost:8787/webhook", {
        allowInsecureLocal: true,
      }),
    ).toBe("http://localhost:8787/webhook");
  });

  it("allows http 127.0.0.1 when allowInsecureLocal is true", () => {
    expect(
      validateWebhookUrl("http://127.0.0.1:8787/webhook", {
        allowInsecureLocal: true,
      }),
    ).toBe("http://127.0.0.1:8787/webhook");
  });

  it("rejects loopback https", () => {
    expect(() => validateWebhookUrl("https://127.0.0.1/hook")).toThrow(
      WebhookUrlValidationError,
    );
  });

  it("rejects private RFC1918 addresses", () => {
    expect(() => validateWebhookUrl("https://10.0.0.1/hook")).toThrow(
      WebhookUrlValidationError,
    );
    expect(() => validateWebhookUrl("https://192.168.1.1/hook")).toThrow(
      WebhookUrlValidationError,
    );
  });

  it("rejects *.internal and *.local hostnames", () => {
    expect(() => validateWebhookUrl("https://foo.internal/hook")).toThrow(
      WebhookUrlValidationError,
    );
    expect(() => validateWebhookUrl("https://foo.local/hook")).toThrow(
      WebhookUrlValidationError,
    );
  });

  it("uses custom fieldLabel in error messages", () => {
    expect(() => validateWebhookUrl("", { fieldLabel: "webhookUrl" })).toThrow(
      "webhookUrl is required",
    );
  });
});
