/**
 * Deploy-time `${env:VAR}` substitution and escape behaviour.
 */

import { describe, expect, it } from "vitest";

import { substituteEnvTemplates } from "../src/substitute-env-templates.js";

describe("substituteEnvTemplates", () => {
  it("substitutes inline ${env:VAR} tokens", () => {
    const out = substituteEnvTemplates(
      "https://base.g.alchemy.com/v2/${env:ALCHEMY_API_KEY}",
      { ALCHEMY_API_KEY: "secret-key" },
    );
    expect(out).toBe("https://base.g.alchemy.com/v2/secret-key");
  });

  it("leaves escaped \\${env:VAR} literals unchanged", () => {
    const out = substituteEnvTemplates("\\${env:ALCHEMY_API_KEY}", {});
    expect(out).toBe("${env:ALCHEMY_API_KEY}");
  });

  it("throws when a referenced env var is missing", () => {
    expect(() =>
      substituteEnvTemplates("https://x/${env:MISSING}", {}),
    ).toThrow(/MISSING/);
  });

  it("passes through strings without templates", () => {
    expect(substituteEnvTemplates("https://sepolia.base.org", {})).toBe(
      "https://sepolia.base.org",
    );
  });
});
