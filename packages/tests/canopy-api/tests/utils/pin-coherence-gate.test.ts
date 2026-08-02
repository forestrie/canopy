import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCanopyPinContract,
  parsePinContractJsonc,
} from "../../src/pin-coherence-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");
const shippedContract = resolve(repoRoot, "pin-contract.jsonc");

describe("canopy pin contract", () => {
  it("loads the contract that ships in this repo", () => {
    const contract = loadCanopyPinContract(shippedContract);
    expect(contract.suite).toBe("canopy");
    expect(contract.pins.length).toBeGreaterThan(0);
  });

  it("declares both halves and a store for every pin", () => {
    // A pin that names only one half cannot produce the report this exists for
    // — "which store holds each side" is the actionable part.
    for (const pin of loadCanopyPinContract(shippedContract).pins) {
      expect(pin.id).toBeTruthy();
      expect(pin.instanceVar).toBeTruthy();
      expect(pin.keyVar ?? pin.keySecret).toBeTruthy();
      expect(pin.chainVar).toBeTruthy();
      expect(pin.invariants.length).toBeGreaterThan(0);
    }
  });

  it("declares the pins this suite actually resolves in tests-system.yml", () => {
    const byId = new Map(
      loadCanopyPinContract(shippedContract).pins.map((p) => [p.id, p]),
    );
    expect(byId.get("es256-bootstrap")?.instanceVar).toBe(
      "E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP",
    );
    expect(byId.get("es256-bootstrap")?.keySecret).toBe(
      "E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE",
    );
    // No ks256 pin: on the dev tier that pin is half-present (instance set via
    // the job-output chain, key absent), which the checker correctly flags and
    // which blocked canopy v0.1.8. See the rationale in pin-contract.jsonc.
    expect(byId.has("ks256-bootstrap")).toBe(false);
  });

  it("parses comments and trailing commas, which the contract uses", () => {
    const parsed = parsePinContractJsonc(`{
      // leading comment
      "schemaVersion": 1,
      "suite": "x",
      "pins": [
        { "id": "p", "instanceVar": "I", "keyVar": "K", "keyKind": "eth-address",
          "alg": "ks256", "chainVar": "C", "invariants": ["instanceHasCode"] },
      ],
    }`);
    expect(parsed.pins[0]!.id).toBe("p");
  });

  it("does not treat a // inside a string as a comment", () => {
    const parsed = parsePinContractJsonc(
      '{ "schemaVersion": 1, "suite": "https://example.test", "pins": [] }',
    );
    expect(parsed.suite).toBe("https://example.test");
  });

  it("refuses to pass vacuously on an empty pin list", () => {
    expect(() =>
      loadCanopyPinContract(
        resolve(__dirname, "fixtures/pin-contract-empty.jsonc"),
      ),
    ).toThrow(/refusing to pass vacuously/);
  });
});
