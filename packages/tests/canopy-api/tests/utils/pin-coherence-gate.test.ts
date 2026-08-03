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
    // The address half, not the key: the signer is resolved without the key
    // crossing a job boundary (canopy#211/#215), and a ks256 bootstrapConfig()
    // carries exactly those 20 address bytes.
    expect(byId.get("ks256-bootstrap")?.keyVar).toBe(
      "E2E_UNIVOCITY_KS256_BOOTSTRAP_SIGNER",
    );
  });

  /**
   * Regression guard for FOR-531. The not-configured sentinel existed because
   * the retired pin resolver substituted a placeholder for an unconfigured
   * KS256 address. Both instances are now deployed fresh every run with keys
   * the suite generates, so a missing address is a genuine failure — declaring
   * `absentWhen` again would turn it back into a silent skip.
   *
   * The kit keeps `KS256_UNIVOCITY_MANIFEST_PLACEHOLDER` and still honours
   * `absentWhen`: system-testing lane manifests can carry it. Only canopy's own
   * declaration no longer needs it.
   */
  it("declares no not-configured sentinel, so a missing address fails loudly", () => {
    const contract = loadCanopyPinContract();
    for (const pin of contract.pins) {
      expect(
        pin.absentWhen,
        `pin ${pin.id} must not skip on a sentinel`,
      ).toBeUndefined();
    }
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
